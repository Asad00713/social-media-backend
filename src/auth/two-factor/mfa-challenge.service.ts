import { createHmac } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { loginChallenges } from '../../drizzle/schema/two-factor.schema';
import { mfaChallengeExpired } from './mfa-errors';

export const MFA_CHALLENGE_TTL_SECONDS = 300;
export const MAX_CHALLENGE_ATTEMPTS = 5;
/** A challenge row expired this long ago is deleted on the user's next one (B8). */
const PRUNE_AFTER = sql`interval '1 day'`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ChallengeClaims {
  sub?: unknown;
  cid?: unknown;
  purpose?: unknown;
}

/**
 * The step between a correct first factor and the second (spec §7.2).
 *
 * A signed token `{sub, cid, purpose:'mfa'}` that lives 5 minutes, bound to a
 * `login_challenges` row and consumed at most once. It is signed with its
 * own key - `MFA_CHALLENGE_SECRET`, or HMAC-SHA256(JWT_ACCESS_SECRET,
 * 'mfa-challenge') - so it never verifies as an access token, and it carries
 * `purpose` so JwtStrategy would refuse it even if it did (Review Focus 1).
 * Five code attempts per challenge, reserved by one atomic UPDATE before
 * each code is evaluated; the fifth wrong one burns the row.
 */
@Injectable()
export class MfaChallengeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async create(userId: string, deviceHash: string | null): Promise<string> {
    const key = this.key();
    await this.db
      .delete(loginChallenges)
      .where(
        and(
          eq(loginChallenges.userId, userId),
          eq(loginChallenges.purpose, 'mfa'),
          lt(loginChallenges.expiresAt, sql`now() - ${PRUNE_AFTER}`),
        ),
      );
    const [row] = await this.db
      .insert(loginChallenges)
      .values({
        userId,
        purpose: 'mfa',
        deviceHash,
        expiresAt: sql`now() + make_interval(secs => ${MFA_CHALLENGE_TTL_SECONDS})`,
      })
      .returning({ id: loginChallenges.id });
    return this.jwt.sign(
      { sub: userId, cid: row.id, purpose: 'mfa' },
      { secret: key, expiresIn: MFA_CHALLENGE_TTL_SECONDS },
    );
  }

  /** The live challenge behind a token, or MFA_CHALLENGE_EXPIRED. */
  async open(
    token: string,
  ): Promise<{ cid: string; userId: string; deviceHash: string | null }> {
    let claims: ChallengeClaims;
    try {
      claims = this.jwt.verify<ChallengeClaims & object>(token, {
        secret: this.key(),
      });
    } catch {
      throw mfaChallengeExpired();
    }
    const { sub, cid, purpose } = claims;
    if (
      purpose !== 'mfa' ||
      typeof sub !== 'string' ||
      typeof cid !== 'string' ||
      !UUID.test(cid) ||
      !UUID.test(sub)
    ) {
      throw mfaChallengeExpired();
    }
    const [row] = await this.db
      .select({
        id: loginChallenges.id,
        userId: loginChallenges.userId,
        deviceHash: loginChallenges.deviceHash,
      })
      .from(loginChallenges)
      .where(
        and(
          eq(loginChallenges.id, cid),
          eq(loginChallenges.userId, sub),
          eq(loginChallenges.purpose, 'mfa'),
          isNull(loginChallenges.consumedAt),
          gt(loginChallenges.expiresAt, sql`now()`),
        ),
      )
      .limit(1);
    if (!row) throw mfaChallengeExpired();
    return { cid: row.id, userId: row.userId, deviceHash: row.deviceHash };
  }

  /**
   * Reserves one code attempt BEFORE the code is evaluated (batch-2 review
   * ruling 1): `attempts + 1 ... WHERE attempts < 5` in one UPDATE, so N
   * requests racing on one challenge get at most five evaluations between
   * them - a read-then-check would let all N past. Returns the attempts left
   * after this one (4..0); no live row, or all five taken, is
   * MFA_CHALLENGE_EXPIRED. The fifth reservation does NOT consume the row:
   * if that fifth code is right, `consume` must still succeed. A wrong fifth
   * code is followed by `burn`.
   */
  async reserveAttempt(cid: string): Promise<number> {
    const [row] = await this.db
      .update(loginChallenges)
      .set({ attempts: sql`${loginChallenges.attempts} + 1` })
      .where(
        and(
          eq(loginChallenges.id, cid),
          isNull(loginChallenges.consumedAt),
          gt(loginChallenges.expiresAt, sql`now()`),
          lt(loginChallenges.attempts, MAX_CHALLENGE_ATTEMPTS),
        ),
      )
      .returning({ attempts: loginChallenges.attempts });
    if (!row) throw mfaChallengeExpired();
    return Math.max(0, MAX_CHALLENGE_ATTEMPTS - row.attempts);
  }

  /**
   * Gives back a reserved attempt whose code was never judged wrong (the
   * account was locked, the body was ambiguous, a dependency failed).
   * Best effort: never throws, never goes below zero.
   */
  async release(cid: string): Promise<void> {
    try {
      await this.db
        .update(loginChallenges)
        .set({
          attempts: sql`GREATEST(${loginChallenges.attempts} - 1, 0)`,
        })
        .where(
          and(eq(loginChallenges.id, cid), isNull(loginChallenges.consumedAt)),
        );
    } catch {
      // The attempt stays spent: stricter, never looser.
    }
  }

  /** Kills the challenge after its last wrong code. */
  async burn(cid: string): Promise<void> {
    await this.db
      .update(loginChallenges)
      .set({ consumedAt: sql`now()` })
      .where(
        and(eq(loginChallenges.id, cid), isNull(loginChallenges.consumedAt)),
      );
  }

  /** Spends the challenge. False when it was already spent or has expired. */
  async consume(cid: string): Promise<boolean> {
    const rows = await this.db
      .update(loginChallenges)
      .set({ consumedAt: sql`now()` })
      .where(
        and(
          eq(loginChallenges.id, cid),
          isNull(loginChallenges.consumedAt),
          gt(loginChallenges.expiresAt, sql`now()`),
        ),
      )
      .returning({ id: loginChallenges.id });
    return rows.length > 0;
  }

  private key(): string {
    const own = this.config.get<string>('MFA_CHALLENGE_SECRET');
    if (own) return own;
    const access = this.config.get<string>('JWT_ACCESS_SECRET');
    if (!access) throw new Error('JWT_ACCESS_SECRET is not defined');
    return createHmac('sha256', access).update('mfa-challenge').digest('hex');
  }
}
