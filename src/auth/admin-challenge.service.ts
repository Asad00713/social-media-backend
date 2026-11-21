import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { and, desc, eq, isNull, gt, lt, sql } from 'drizzle-orm';
import { DRIZZLE } from '../drizzle/drizzle.module';
import type { DbType } from '../drizzle/db';
import { adminLoginChallenges, users } from '../drizzle/schema';
import { loginChallenges } from '../drizzle/schema/two-factor.schema';
import { EmailOutboxService } from '../email/queue/email-outbox.service';
import { adminLoginCodeTemplate } from '../email/templates/security/admin-login-code';
import { generateOtp, hash } from '../common/utils/encryption.util';

/** Ten minutes, matching the email-verification OTP already in this codebase. */
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

/**
 * The window in which the verified code can be spent on a password attempt.
 * Short on purpose: it exists to carry you from one form field to the next,
 * not to be a session.
 */
const CHALLENGE_TOKEN_TTL = '5m';
/** The same five minutes, on the `login_challenges` row behind the token. */
const CHALLENGE_TOKEN_TTL_SECONDS = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Five wrong guesses kills the challenge. Six digits is only 1,000,000. */
const MAX_ATTEMPTS = 5;

/** One code per address per minute, so nobody can use us to flood an inbox. */
const REQUEST_COOLDOWN_MS = 60 * 1000;

export interface ChallengeTokenPayload {
  sub: string;
  email: string;
  /** The `login_challenges` row (purpose 'admin_email') that makes it single-use. */
  cid: string;
  purpose: 'admin-login';
}

/**
 * Thrown only for an address that really is a super admin, and only when a
 * usable code was issued moments ago.
 *
 * This does leak one bit — a stranger who guessed the right address twice in a
 * minute would see it. That is accepted deliberately: they must already know
 * the address, and the alternative is telling the actual owner that mail is
 * coming when none is. Silence there costs a real person ten minutes of
 * staring at an empty inbox.
 */
export class ChallengeCooldownError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super(`Wait ${retryAfterSeconds}s before requesting another code.`);
    this.name = 'ChallengeCooldownError';
  }
}

@Injectable()
export class AdminChallengeService {
  private readonly logger = new Logger(AdminChallengeService.name);

  constructor(
    @Inject(DRIZZLE) private db: DbType,
    private jwtService: JwtService,
    private configService: ConfigService,
    private emailOutbox: EmailOutboxService,
  ) {}

  /**
   * Step one of admin sign-in: email a code.
   *
   * Always resolves the same way. Whether the address is unknown, belongs to a
   * regular user, or belongs to a suspended account, the caller is told a code
   * was sent. Any difference here — a different message, a different status, a
   * noticeably different response time — turns this endpoint into a way to
   * discover which address owns the platform.
   */
  async requestChallenge(email: string, requestIp?: string): Promise<void> {
    const normalized = email.trim().toLowerCase();

    const user = await this.db.query.users.findFirst({
      where: eq(users.email, normalized),
    });

    // Everything below is silent. The caller's view never changes.
    if (!user || user.role !== 'SUPER_ADMIN' || !user.isActive) {
      this.logger.warn(
        `Admin challenge requested for non-eligible address (ip: ${requestIp ?? 'unknown'})`,
      );
      return;
    }

    // `isNull(consumedAt)` matters as much as the time window. The cooldown
    // exists to protect a code that is still usable — once one has been spent
    // there is nothing left to protect, and holding the user back would trap
    // them: the right code is spent at verify (exchanged for a single-use
    // login token, consumed only after the password passes), so someone whose
    // token then expired or was used comes back here for a new code, which a
    // consumed-code cooldown would refuse.
    const recent = await this.db.query.adminLoginChallenges.findFirst({
      where: and(
        eq(adminLoginChallenges.userId, user.id),
        isNull(adminLoginChallenges.consumedAt),
        gt(
          adminLoginChallenges.createdAt,
          new Date(Date.now() - REQUEST_COOLDOWN_MS),
        ),
      ),
      orderBy: [desc(adminLoginChallenges.createdAt)],
    });

    if (recent) {
      // Inside the cooldown: the code already in their inbox is still valid,
      // so reissuing would only invalidate the one they are about to type.
      //
      // This used to return silently, which produced the worst possible
      // screen — "a code is on its way" while nothing was sent. A wrong
      // password drops the form back to the email step, so anyone who
      // mistyped once landed here immediately and waited on mail that was
      // never coming. The caller is told to wait now, and told how long.
      const waitMs =
        REQUEST_COOLDOWN_MS - (Date.now() - recent.createdAt.getTime());

      throw new ChallengeCooldownError(Math.max(1, Math.ceil(waitMs / 1000)));
    }

    const otp = generateOtp(6);

    const [challenge] = await this.db
      .insert(adminLoginChallenges)
      .values({
        userId: user.id,
        otpHash: hash(otp),
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
        requestIp: requestIp?.slice(0, 45),
      })
      .returning({ id: adminLoginChallenges.id });

    // Inline, never queued: queued job data (the code included) would sit in
    // Redis and Bull Board for a day. The challenge id keys the send, so a
    // retry of this request cannot double-send one code.
    const result = await this.emailOutbox.sendNow({
      template: adminLoginCodeTemplate,
      props: { code: otp, ip: requestIp?.slice(0, 45) ?? null },
      to: { email: user.email, userId: user.id },
      workspaceId: null,
      idempotencyKey: `admin-code.${challenge.id}`,
    });
    if (!result.success) {
      this.logger.error(
        // The code only: a provider message can quote the recipient address.
        `Admin login code email for user ${user.id} failed: ${result.errorCode ?? (result.retryable ? 'retryable' : 'failed')}`,
      );
    }

    // Without a mail provider configured locally the send above is a no-op,
    // which would leave nothing to type. This is the only way in during local
    // development, and it is gated on the environment rather than a flag. It
    // is development only, not "anything but production": staging logs are
    // shared, and must never hold a code or the address it was sent to.
    if (this.configService.get<string>('NODE_ENV') === 'development') {
      this.logger.debug(`Admin login code: ${otp}`);
    }
  }

  /**
   * Step two: exchange a correct code for a short-lived, single-use token
   * that the password step will demand.
   *
   * Every guess first takes one of the five attempts in a single conditional
   * UPDATE (`attempts + 1 ... WHERE attempts < 5`), and only then is the code
   * compared: parallel guesses cannot test a sixth code, which a
   * read-then-write counter allowed. A right code is spent by another
   * conditional UPDATE, so two parallel right answers yield one token. The
   * token is bound to a `login_challenges` row (purpose 'admin_email'),
   * consumed by the password step, so it opens exactly one sign-in.
   */
  async verifyChallenge(email: string, otp: string): Promise<string> {
    const normalized = email.trim().toLowerCase();

    const user = await this.db.query.users.findFirst({
      where: eq(users.email, normalized),
    });

    if (!user || user.role !== 'SUPER_ADMIN' || !user.isActive) {
      throw new UnauthorizedException('That code did not work.');
    }

    const challenge = await this.db.query.adminLoginChallenges.findFirst({
      where: and(
        eq(adminLoginChallenges.userId, user.id),
        isNull(adminLoginChallenges.consumedAt),
        gt(adminLoginChallenges.expiresAt, new Date()),
      ),
      orderBy: [desc(adminLoginChallenges.createdAt)],
    });

    if (!challenge) {
      throw new UnauthorizedException('That code did not work.');
    }

    const [reserved] = await this.db
      .update(adminLoginChallenges)
      .set({ attempts: sql`${adminLoginChallenges.attempts} + 1` })
      .where(
        and(
          eq(adminLoginChallenges.id, challenge.id),
          isNull(adminLoginChallenges.consumedAt),
          lt(adminLoginChallenges.attempts, MAX_ATTEMPTS),
          // Again here: a code that expired since the read above is refused.
          gt(adminLoginChallenges.expiresAt, sql`now()`),
        ),
      )
      .returning({ attempts: adminLoginChallenges.attempts });

    if (!reserved) {
      // Every attempt is taken: burn it rather than leaving a dead row that
      // keeps being found.
      await this.db
        .update(adminLoginChallenges)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(adminLoginChallenges.id, challenge.id),
            isNull(adminLoginChallenges.consumedAt),
          ),
        );
      throw new UnauthorizedException('That code did not work.');
    }

    if (hash(otp) !== challenge.otpHash) {
      // The attempt was already counted by the reservation.
      throw new UnauthorizedException('That code did not work.');
    }

    // Spend it. A correct code is worth exactly one password attempt.
    const spent = await this.db
      .update(adminLoginChallenges)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(adminLoginChallenges.id, challenge.id),
          isNull(adminLoginChallenges.consumedAt),
        ),
      )
      .returning({ id: adminLoginChallenges.id });
    if (spent.length === 0) {
      throw new UnauthorizedException('That code did not work.');
    }

    // B8 hygiene: this user's admin tokens expired over a day ago go.
    await this.db
      .delete(loginChallenges)
      .where(
        and(
          eq(loginChallenges.userId, user.id),
          eq(loginChallenges.purpose, 'admin_email'),
          lt(loginChallenges.expiresAt, sql`now() - interval '1 day'`),
        ),
      );
    const [row] = await this.db
      .insert(loginChallenges)
      .values({
        userId: user.id,
        purpose: 'admin_email',
        expiresAt: sql`now() + make_interval(secs => ${CHALLENGE_TOKEN_TTL_SECONDS})`,
      })
      .returning({ id: loginChallenges.id });

    return this.signChallengeToken(user.id, user.email, row.id);
  }

  /**
   * Called by the login path, after the password was found right (so a
   * typo does not burn the emailed code). Throws 401 unless the token was
   * minted by `verifyChallenge` for this exact user AND its row is still
   * unspent: the row is consumed here, so one emailed code opens exactly one
   * sign-in, however often the token is replayed inside its 5 minutes.
   */
  async consumeChallengeToken(
    token: string | undefined,
    userId: string,
  ): Promise<void> {
    if (!token) {
      throw new UnauthorizedException('Invalid credentials');
    }

    let payload: Partial<ChallengeTokenPayload>;
    try {
      payload = this.jwtService.verify<ChallengeTokenPayload>(token, {
        secret: this.challengeSecret(),
      });
    } catch {
      throw new UnauthorizedException('Invalid credentials');
    }

    // The purpose claim stops an ordinary access token from ever standing
    // in for a challenge token; the cid ties it to one unspent row.
    if (
      payload.purpose !== 'admin-login' ||
      payload.sub !== userId ||
      typeof payload.cid !== 'string' ||
      !UUID.test(payload.cid) ||
      !UUID.test(userId)
    ) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const spent = await this.db
      .update(loginChallenges)
      .set({ consumedAt: sql`now()` })
      .where(
        and(
          eq(loginChallenges.id, payload.cid),
          eq(loginChallenges.userId, userId),
          eq(loginChallenges.purpose, 'admin_email'),
          isNull(loginChallenges.consumedAt),
          gt(loginChallenges.expiresAt, sql`now()`),
        ),
      )
      .returning({ id: loginChallenges.id });
    if (spent.length === 0) {
      throw new UnauthorizedException('Invalid credentials');
    }
  }

  /** Housekeeping: drop rows that can no longer be used. */
  async purgeExpired(): Promise<number> {
    const deleted = await this.db
      .delete(adminLoginChallenges)
      .where(lt(adminLoginChallenges.expiresAt, new Date()))
      .returning({ id: adminLoginChallenges.id });

    return deleted.length;
  }

  private signChallengeToken(
    userId: string,
    email: string,
    cid: string,
  ): string {
    const payload: ChallengeTokenPayload = {
      sub: userId,
      email,
      cid,
      purpose: 'admin-login',
    };

    return this.jwtService.sign(payload, {
      secret: this.challengeSecret(),
      expiresIn: CHALLENGE_TOKEN_TTL,
    });
  }

  /**
   * Its own secret, falling back to the access secret so this works without a
   * new environment variable. Setting ADMIN_CHALLENGE_SECRET separately means a
   * leaked access secret cannot be used to forge the second factor, which is
   * the entire point of having one.
   */
  private challengeSecret(): string {
    const secret =
      this.configService.get<string>('ADMIN_CHALLENGE_SECRET') ??
      this.configService.get<string>('JWT_ACCESS_SECRET');

    if (!secret) {
      throw new Error('No secret available to sign admin challenge tokens');
    }

    return secret;
  }
}
