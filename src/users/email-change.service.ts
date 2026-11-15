import { createHash, randomInt, timingSafeEqual } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import { isEmailAllowlisted } from '../auth/allowlist';
import { GeoipService } from '../auth/services/geoip.service';
import {
  MAX_CODE_ATTEMPTS,
  verificationCodeError,
} from '../auth/verification-code-error';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import { users } from '../drizzle/schema/users.schema';
import { AppLinks } from '../email/links/app-links';
import { formatWhen } from '../email/links/format-when';
import { EmailOutboxService } from '../email/queue/email-outbox.service';
import { changeEmailCodeTemplate } from '../email/templates/security/change-email-code';
import {
  emailChangedTemplate,
  type EmailChangedProps,
} from '../email/templates/security/email-changed';
import { EmailTokensService } from '../email/tokens/email-tokens.service';
import { RecipientsService } from '../notifications/recipients.service';
import {
  AccountSecurityService,
  type RequestContext,
} from './account-security.service';
import { normalizeEmail } from './normalize-email';
import { toPublicUser, type PublicUser } from './users.service';

export interface RequestEmailChangeInput {
  newEmail: string;
  currentPassword?: string;
}

const CODE_TTL_MS = 10 * 60 * 1000;

/** The root db or the confirm transaction: both run the same queries. */
type Executor = DbType | Parameters<Parameters<DbType['transaction']>[0]>[0];

/** Every pending column back to "no change open". */
const NO_PENDING_CHANGE = {
  pendingEmail: null,
  pendingEmailCodeHash: null,
  pendingEmailExpiresAt: null,
  pendingEmailAttempts: 0,
};

/** What the confirm transaction decided; refusals that wrote something commit first. */
type ConfirmOutcome =
  | { kind: 'invalid'; attemptsLeft: number }
  | { kind: 'locked' }
  | { kind: 'changed'; row: typeof users.$inferSelect; oldEmail: string };

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** Constant time, so the response time says nothing about how close a guess was. */
function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** node-postgres reports unique violations as 23505, sometimes wrapped by Drizzle. */
function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

/** The body shape of spec Appendix A.2: `{statusCode, error, code, message}`. */
function changeError(code: string, message: string): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code,
    message,
  });
}

function emailTaken(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'EMAIL_TAKEN',
    message: 'Another account already uses that email.',
  });
}

/**
 * Changing the sign-in email (spec §7.1). The new address gets a 6-digit code
 * (A3) and `email` changes only when the code comes back, so nobody can move
 * an account onto an address they do not read. The old address then hears
 * about it (A4), with a 7-day link that switches the email back.
 */
@Injectable()
export class EmailChangeService {
  private readonly logger = new Logger(EmailChangeService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly security: AccountSecurityService,
    private readonly outbox: EmailOutboxService,
    private readonly tokens: EmailTokensService,
    private readonly links: AppLinks,
    private readonly geoip: GeoipService,
    private readonly recipients: RecipientsService,
  ) {}

  /**
   * Stores the pending change and mails the code to the new address. A second
   * request replaces the first: its code stops working and the count of wrong
   * guesses starts again.
   */
  async request(
    userId: string,
    body: RequestEmailChangeInput,
  ): Promise<{ pendingEmail: string; expiresAt: string }> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { id: true, email: true, password: true, role: true },
    });
    if (!user) throw new NotFoundException('User not found');
    await this.security.verifyCurrentPassword(user, body.currentPassword);

    const newEmail = normalizeEmail(body.newEmail);
    if (newEmail === normalizeEmail(user.email)) {
      throw changeError('EMAIL_UNCHANGED', "That's already your email.");
    }
    // Before launch the gate admits listed addresses only: moving onto an
    // unlisted one would lock the person out of the app (spec A.2).
    if (!isEmailAllowlisted(newEmail, user.role)) {
      throw changeError(
        'EMAIL_NOT_ALLOWLISTED',
        "That address isn't on the early-access list yet.",
      );
    }
    if (await this.isTaken(this.db, newEmail, userId)) throw emailTaken();

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const codeHash = sha256(code);
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await this.db
      .update(users)
      .set({
        pendingEmail: newEmail,
        pendingEmailCodeHash: codeHash,
        pendingEmailExpiresAt: expiresAt,
        pendingEmailAttempts: 0,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    // Inline, never queued: the code must not sit in Redis or Bull Board.
    const sent = await this.outbox.sendNow({
      template: changeEmailCodeTemplate,
      props: { code, newEmail },
      to: { email: newEmail, userId },
      workspaceId: null,
      idempotencyKey: `change-email-code.${userId}.${expiresAt.getTime()}`,
    });
    if (!sent.success) {
      // The code only: a provider message can quote the recipient address.
      this.logger.warn(
        `Change-email code for user ${userId} was not sent (${sent.errorCode ?? (sent.retryable ? 'retryable' : 'failed')})`,
      );
      // Only this request's code: a newer request may already have replaced it.
      await this.db
        .update(users)
        .set({ ...NO_PENDING_CHANGE, updatedAt: new Date() })
        .where(
          and(eq(users.id, userId), eq(users.pendingEmailCodeHash, codeHash)),
        );
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'Service Unavailable',
        code: 'EMAIL_SEND_FAILED',
        message: "We couldn't send the code. Try again in a minute.",
      });
    }
    return { pendingEmail: newEmail, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Checks the code and switches the email, in one transaction with the row
   * locked, so two confirms cannot both spend the last attempt or both
   * switch. The address is checked again: someone may have signed up with it
   * since the request. Then A4 goes to the OLD address.
   */
  async confirm(
    userId: string,
    code: string,
    ctx: RequestContext,
  ): Promise<PublicUser> {
    const typed = code.replace(/\s/g, '');
    let outcome: ConfirmOutcome;
    try {
      outcome = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .select({
            email: users.email,
            pendingEmail: users.pendingEmail,
            pendingEmailCodeHash: users.pendingEmailCodeHash,
            pendingEmailExpiresAt: users.pendingEmailExpiresAt,
            pendingEmailAttempts: users.pendingEmailAttempts,
          })
          .from(users)
          .where(eq(users.id, userId))
          .for('update');
        if (!row) throw new NotFoundException('User not found');
        const { pendingEmail, pendingEmailCodeHash, pendingEmailExpiresAt } =
          row;
        if (!pendingEmail || !pendingEmailCodeHash || !pendingEmailExpiresAt) {
          throw changeError(
            'EMAIL_CHANGE_NOT_STARTED',
            'Start the email change again.',
          );
        }
        if (pendingEmailExpiresAt.getTime() <= Date.now()) {
          throw verificationCodeError(
            'CODE_EXPIRED',
            'That code has expired. Send a new one.',
          );
        }
        if (row.pendingEmailAttempts >= MAX_CODE_ATTEMPTS) {
          await this.clearPending(tx, userId);
          return { kind: 'locked' };
        }
        if (!sameHash(sha256(typed), pendingEmailCodeHash)) {
          const attempts = row.pendingEmailAttempts + 1;
          if (attempts >= MAX_CODE_ATTEMPTS) {
            await this.clearPending(tx, userId);
            return { kind: 'locked' };
          }
          await tx
            .update(users)
            .set({ pendingEmailAttempts: attempts, updatedAt: new Date() })
            .where(eq(users.id, userId));
          return {
            kind: 'invalid',
            attemptsLeft: MAX_CODE_ATTEMPTS - attempts,
          };
        }
        if (await this.isTaken(tx, pendingEmail, userId)) throw emailTaken();

        const [updated] = await tx
          .update(users)
          .set({
            ...NO_PENDING_CHANGE,
            email: pendingEmail,
            isEmailVerified: true,
            updatedAt: new Date(),
          })
          .where(eq(users.id, userId))
          .returning();
        return { kind: 'changed', row: updated, oldEmail: row.email };
      });
    } catch (err) {
      // The address registered between our check and the write.
      if (isUniqueViolation(err)) throw emailTaken();
      throw err;
    }

    if (outcome.kind === 'locked') {
      throw verificationCodeError(
        'CODE_LOCKED',
        'Too many wrong codes. Start the email change again.',
      );
    }
    if (outcome.kind === 'invalid') {
      throw verificationCodeError('CODE_INVALID', "That code isn't right.", {
        attemptsLeft: outcome.attemptsLeft,
      });
    }

    await this.sendEmailChanged(
      userId,
      outcome.oldEmail,
      outcome.row.email,
      ctx,
    );
    return toPublicUser(outcome.row);
  }

  /**
   * A4 to the OLD address, queued. Its "Secure my account" token is defensive
   * only (it can switch the email back to that same old address and sign the
   * account out), so unlike the A3 code it may sit in the queue and gain the
   * retries. Never throws: the email has already changed.
   */
  private async sendEmailChanged(
    userId: string,
    from: string,
    to: string,
    ctx: RequestContext,
  ): Promise<void> {
    try {
      const [timeZone, geo] = await Promise.all([
        this.recipients.userTimezone(userId),
        this.geoip.lookup(ctx.ip),
      ]);
      const browser = this.security.deviceLabel(ctx.userAgent);
      const token = this.tokens.securityToken({
        uid: userId,
        act: 'revert_email',
        from,
        to,
      });
      const props: EmailChangedProps = {
        from,
        to,
        when: formatWhen(new Date(), timeZone),
        device: geo?.country ? `${browser} · ${geo.country}` : browser,
        secureUrl: this.links.api('/email/security/' + token),
      };
      await this.outbox.enqueue({
        template: emailChangedTemplate,
        props,
        to: { email: from, userId },
        workspaceId: null,
        idempotencyKey: `email-changed.${userId}.${Date.now()}`,
      });
    } catch (err) {
      this.logger.warn(
        `Email-changed notice for user ${userId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async clearPending(db: Executor, userId: string): Promise<void> {
    await db
      .update(users)
      .set({ ...NO_PENDING_CHANGE, updatedAt: new Date() })
      .where(eq(users.id, userId));
  }

  /** Another account signs in with this address (older rows may be mixed case). */
  private async isTaken(
    db: Executor,
    email: string,
    userId: string,
  ): Promise<boolean> {
    const [other] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(sql`lower(${users.email}) = ${email}`, ne(users.id, userId)))
      .limit(1);
    return Boolean(other);
  }
}
