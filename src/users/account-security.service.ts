import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { and, eq, isNotNull } from 'drizzle-orm';
import { deviceLabel } from '../auth/devices/device-label';
import { GeoipService } from '../auth/services/geoip.service';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import { users } from '../drizzle/schema/users.schema';
import { AppLinks } from '../email/links/app-links';
import { formatWhen } from '../email/links/format-when';
import {
  passwordChangedTemplate,
  type PasswordChangedProps,
} from '../email/templates/security/password-changed';
import {
  signInMethodChangedTemplate,
  type SignInMethodChangedProps,
} from '../email/templates/security/sign-in-method-changed';
import { EmailTokensService } from '../email/tokens/email-tokens.service';
import { NotificationEmitterService } from '../notifications/notification-emitter.service';
import { NotifyService } from '../notifications/notify.service';
import { RecipientsService } from '../notifications/recipients.service';
import { toPublicUser, type PublicUser } from './users.service';

/** Where the request came from, for the A5 Device and Location rows. */
export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

export interface ChangePasswordInput {
  currentPassword?: string;
  newPassword: string;
  /** Default true: only an explicit false keeps the other sessions signed in. */
  revokeOtherSessions?: boolean;
}

const BCRYPT_ROUNDS = 10;

/**
 * Always a 400 (spec Appendix A.3). The frontend's API client answers a 401 by
 * refreshing the session and replaying the request, so a wrong current
 * password sent back as 401 would be submitted twice.
 */
function accountError(code: string, message: string): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code,
    message,
  });
}

/** A 409 with a machine code, in the same body shape as `accountError`. */
function accountConflict(code: string, message: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code,
    message,
  });
}

/**
 * Changing the password from Settings, ending sessions, and the A5 email. The
 * change email flow (Task 7) reuses `verifyCurrentPassword` and
 * `revokeSessions`; the new sign-in email (Task 8) uses `deviceLabel`.
 */
@Injectable()
export class AccountSecurityService {
  private readonly logger = new Logger(AccountSecurityService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly notify: NotifyService,
    private readonly recipients: RecipientsService,
    private readonly tokens: EmailTokensService,
    private readonly links: AppLinks,
    private readonly geoip: GeoipService,
    private readonly emitter: NotificationEmitterService,
  ) {}

  /**
   * A Google-only account (no password) is refused: a stolen access token must
   * not be able to add a password. It uses "Forgot password" instead.
   * On success every other session ends; the caller hands this device a fresh
   * token pair, minted after the revocation. `revokeOtherSessions: false` keeps
   * the other sessions (the password still changes and is dated).
   */
  async changePassword(
    userId: string,
    body: ChangePasswordInput,
    ctx: RequestContext,
  ): Promise<void> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { id: true, password: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.password === null) {
      throw accountError(
        'PASSWORD_NOT_SET',
        'Your account signs in with Google. Use "Forgot password" to set a password.',
      );
    }
    await this.verifyCurrentPassword(user, body.currentPassword);
    if (await bcrypt.compare(body.newPassword, user.password)) {
      throw accountError(
        'PASSWORD_UNCHANGED',
        "Choose a password you haven't used here.",
      );
    }

    const password = await bcrypt.hash(body.newPassword, BCRYPT_ROUNDS);
    // One write: there is no moment where the new password works but the old
    // sessions still do. Only an explicit false keeps them.
    const now = new Date();
    await this.db
      .update(users)
      .set({
        password,
        passwordChangedAt: now,
        ...(body.revokeOtherSessions !== false
          ? { sessionsRevokedAt: now }
          : {}),
        updatedAt: now,
      })
      .where(eq(users.id, userId));

    // Detached: the caller mints this device's fresh tokens next, and the old
    // sessions are already refused, so GeoIP, the bell and A5 must not hold
    // up that response. sendPasswordChanged never throws.
    void this.sendPasswordChanged(userId, ctx, 'settings');
  }

  /**
   * Unlinks Google from the account, after the person re-enters their
   * password. A Google-only account (no password) is refused, or the person
   * would be locked out; they set a password through "Forgot password" first.
   * A wrong password is a 400 `WRONG_PASSWORD`, never a 401: the frontend's
   * API client replays a 401 and may sign the person out.
   * Sessions are kept: only the way of signing in changes.
   */
  async disconnectGoogle(
    userId: string,
    currentPassword: string,
    ctx: RequestContext,
  ): Promise<PublicUser> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { id: true, password: true, googleSub: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.password === null) {
      throw accountConflict(
        'NO_PASSWORD',
        'Your account has no password yet. Use "Forgot password" to set one before disconnecting Google.',
      );
    }
    if (user.googleSub === null) {
      throw accountConflict(
        'GOOGLE_NOT_CONNECTED',
        'Google is not connected to this account.',
      );
    }
    if (
      !currentPassword ||
      !(await bcrypt.compare(currentPassword, user.password))
    ) {
      throw accountError('WRONG_PASSWORD', "That password isn't right.");
    }

    // Matches only a row that is still linked: of two clicks racing, the
    // second finds nothing to change and is told so, and sends no email.
    const [updated] = await this.db
      .update(users)
      .set({ googleSub: null, updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNotNull(users.googleSub)))
      .returning();
    if (!updated) {
      throw accountConflict(
        'GOOGLE_NOT_CONNECTED',
        'Google is not connected to this account.',
      );
    }

    // Detached, like the password change: the answer must not wait on GeoIP
    // or the outbox. sendSignInMethodChanged never throws.
    void this.sendSignInMethodChanged(userId, ctx);
    return toPublicUser(updated);
  }

  /**
   * Ends every session: both JWT strategies refuse a token issued before this
   * second. The app clock, not the database's, because the tokens' `iat` comes
   * from the app clock: a database clock running ahead would otherwise refuse
   * the fresh token handed out right after.
   */
  async revokeSessions(userId: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(users)
      .set({ sessionsRevokedAt: now, updatedAt: now })
      .where(eq(users.id, userId));
  }

  /**
   * Throws CURRENT_PASSWORD_REQUIRED or CURRENT_PASSWORD_INCORRECT. An account
   * with no password (Google-only) has nothing to re-enter and passes.
   */
  async verifyCurrentPassword(
    user: { password: string | null },
    current: string | undefined,
  ): Promise<void> {
    if (user.password === null) return;
    if (!current) {
      throw accountError(
        'CURRENT_PASSWORD_REQUIRED',
        'Enter your current password.',
      );
    }
    if (!(await bcrypt.compare(current, user.password))) {
      throw accountError(
        'CURRENT_PASSWORD_INCORRECT',
        "That password isn't right.",
      );
    }
  }

  /**
   * A5 (queued, security footer) and the `passwordChanged` bell, which rings
   * only when the person's `security_alert` in-app switch is on. Never throws:
   * the password has already changed by the time this runs.
   */
  async sendPasswordChanged(
    userId: string,
    ctx: RequestContext,
    via: PasswordChangedProps['via'],
  ): Promise<void> {
    try {
      const [timeZone, geo] = await Promise.all([
        this.recipients.userTimezone(userId),
        this.geoip.lookup(ctx.ip),
      ]);
      const token = this.tokens.securityToken({ uid: userId, act: 'not_me' });
      const props: PasswordChangedProps = {
        when: formatWhen(new Date(), timeZone),
        device: deviceLabel(ctx.userAgent),
        location: geo?.country ?? null,
        via,
        resetUrl: this.links.api('/email/security/' + token),
      };
      await this.notify.notify({
        userId,
        workspaceId: null,
        event: 'security_alert',
        bell: () => this.emitter.passwordChanged(userId),
        email: {
          template: passwordChangedTemplate,
          props,
          idempotencyKey: `password-changed.${userId}.${Date.now()}`,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Password-changed notice for user ${userId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * The "Google sign-in was removed" email (queued, security footer, always
   * sent). It has no bell. Never throws: the account has already changed.
   */
  async sendSignInMethodChanged(
    userId: string,
    ctx: RequestContext,
  ): Promise<void> {
    try {
      const [timeZone, geo] = await Promise.all([
        this.recipients.userTimezone(userId),
        this.geoip.lookup(ctx.ip),
      ]);
      const token = this.tokens.securityToken({ uid: userId, act: 'not_me' });
      const props: SignInMethodChangedProps = {
        when: formatWhen(new Date(), timeZone),
        device: deviceLabel(ctx.userAgent),
        location: geo?.country ?? null,
        method: 'google',
        change: 'disconnected',
        resetUrl: this.links.api('/email/security/' + token),
      };
      await this.notify.notify({
        userId,
        workspaceId: null,
        event: 'security_alert',
        email: {
          template: signInMethodChangedTemplate,
          props,
          idempotencyKey: `sign-in-method-changed.${userId}.${Date.now()}`,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Sign-in-method notice for user ${userId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
