import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { and, desc, eq, isNull, gt, lt } from 'drizzle-orm';
import { DRIZZLE } from '../drizzle/drizzle.module';
import type { DbType } from '../drizzle/db';
import { adminLoginChallenges, users } from '../drizzle/schema';
import { EmailService } from '../email/email.service';
import { generateOtp, hash } from '../common/utils/encryption.util';

/** Ten minutes, matching the email-verification OTP already in this codebase. */
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

/**
 * The window in which the verified code can be spent on a password attempt.
 * Short on purpose: it exists to carry you from one form field to the next,
 * not to be a session.
 */
const CHALLENGE_TOKEN_TTL = '5m';

/** Five wrong guesses kills the challenge. Six digits is only 1,000,000. */
const MAX_ATTEMPTS = 5;

/** One code per address per minute, so nobody can use us to flood an inbox. */
const REQUEST_COOLDOWN_MS = 60 * 1000;

export interface ChallengeTokenPayload {
  sub: string;
  email: string;
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
    private emailService: EmailService,
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
    // them: a wrong password spends the code and returns them here, where a
    // consumed-code cooldown would refuse the replacement they now need.
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

    await this.db.insert(adminLoginChallenges).values({
      userId: user.id,
      otpHash: hash(otp),
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
      requestIp: requestIp?.slice(0, 45),
    });

    await this.emailService.sendEmail({
      to: user.email,
      subject: `${otp} is your Schedura admin code`,
      html: this.buildEmail(otp),
    });

    // Without a mail provider configured locally the send above is a no-op,
    // which would leave nothing to type. This is the only way in during local
    // development, and it is gated on the environment rather than a flag so it
    // cannot be switched on in production by accident.
    if (this.configService.get<string>('NODE_ENV') !== 'production') {
      this.logger.debug(`Admin login code for ${user.email}: ${otp}`);
    }
  }

  /**
   * Step two: exchange a correct code for a short-lived token that the
   * password step will demand.
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

    if (challenge.attempts >= MAX_ATTEMPTS) {
      // Burn it rather than leaving a dead row that keeps being found.
      await this.db
        .update(adminLoginChallenges)
        .set({ consumedAt: new Date() })
        .where(eq(adminLoginChallenges.id, challenge.id));

      throw new UnauthorizedException('That code did not work.');
    }

    if (hash(otp) !== challenge.otpHash) {
      await this.db
        .update(adminLoginChallenges)
        .set({ attempts: challenge.attempts + 1 })
        .where(eq(adminLoginChallenges.id, challenge.id));

      throw new UnauthorizedException('That code did not work.');
    }

    // Spend it. A correct code is worth exactly one password attempt.
    await this.db
      .update(adminLoginChallenges)
      .set({ consumedAt: new Date() })
      .where(eq(adminLoginChallenges.id, challenge.id));

    return this.signChallengeToken(user.id, user.email);
  }

  /**
   * Called by the login path. Throws unless the token was minted by
   * `verifyChallenge` for this exact user.
   */
  verifyChallengeToken(token: string | undefined, userId: string): void {
    if (!token) {
      throw new UnauthorizedException('Invalid credentials');
    }

    let payload: ChallengeTokenPayload;
    try {
      payload = this.jwtService.verify<ChallengeTokenPayload>(token, {
        secret: this.challengeSecret(),
      });
    } catch {
      throw new UnauthorizedException('Invalid credentials');
    }

    // The purpose claim stops an ordinary access token — which is signed with
    // a different secret anyway, but this is the claim that says so out loud —
    // from ever standing in for a challenge token.
    if (payload.purpose !== 'admin-login' || payload.sub !== userId) {
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

  private signChallengeToken(userId: string, email: string): string {
    const payload: ChallengeTokenPayload = {
      sub: userId,
      email,
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

  private buildEmail(otp: string): string {
    return `
      <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 480px;">
        <p style="font-size: 15px; color: #111;">
          Use this code to finish signing in to the Schedura admin dashboard.
        </p>
        <p style="font-size: 32px; font-weight: 600; letter-spacing: 6px; margin: 24px 0; color: #111;">
          ${otp}
        </p>
        <p style="font-size: 14px; color: #555;">
          It expires in 10 minutes and can only be used once.
        </p>
        <p style="font-size: 14px; color: #555;">
          If you did not try to sign in, someone has your password. Change it.
        </p>
      </div>
    `;
  }
}
