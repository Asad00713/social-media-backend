import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { decryptStrict } from '../../common/utils/totp-secret.util';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { knownDevices } from '../../drizzle/schema/known-devices.schema';
import {
  loginChallenges,
  userBackupCodes,
} from '../../drizzle/schema/two-factor.schema';
import { users } from '../../drizzle/schema/users.schema';
import {
  BACKUP_CODE_COUNT,
  hashBackupCode,
  newBackupCodes,
  normalizeBackupCode,
} from './backup-codes';
import { resolveMfaPepper } from './mfa-pepper';
import {
  mfaCodeAmbiguous,
  mfaCodeInvalid,
  mfaCodeRequired,
  mfaLocked,
} from './mfa-errors';
import { matchTotp } from './totp';

/** Consecutive wrong second factors that lock further attempts (B3). */
export const MFA_MAX_FAILURES = 10;
/**
 * How long each lock lasts, by `mfa_lock_count` (locks since the last
 * correct second factor); the last value is the cap (final review finding
 * 4). A slow attacker paying 10 guesses per lock gets ~40 in the first day
 * and 10 a day after that, instead of ~960 a day forever.
 */
export const MFA_LOCK_MINUTES_BY_COUNT = [15, 60, 240, 1440] as const;

/** The lock interval for the current `mfa_lock_count`, in SQL (old row values). */
const nextLockInterval = sql`CASE LEAST(${users.mfaLockCount}, ${sql.raw(String(MFA_LOCK_MINUTES_BY_COUNT.length - 1))})
  ${sql.join(
    MFA_LOCK_MINUTES_BY_COUNT.map(
      (mins, i) =>
        sql`WHEN ${sql.raw(String(i))} THEN make_interval(mins => ${sql.raw(String(mins))})`,
    ),
    sql` `,
  )}
END`;

export interface SecondFactorInput {
  code?: string;
  backupCode?: string;
}
export type SecondFactorMethod = 'totp' | 'backup';

/** The db or a transaction on it. */
export type SecondFactorExecutor = Pick<
  DbType,
  'select' | 'insert' | 'update' | 'delete' | 'execute'
>;

/** Every users column of two-step sign-in, as it is with it off. */
const CLEARED_TWO_FACTOR = {
  totpSecretEnc: null,
  totpPendingSecretEnc: null,
  totpEnabledAt: null,
  totpLastStep: null,
  mfaFailures: 0,
  mfaLockedUntil: null,
  mfaLockCount: 0,
};

const present = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0;

/**
 * Exactly one of `code` / `backupCode`, else MFA_CODE_REQUIRED (or its "not
 * both" variant). Exported so a caller can refuse a malformed body before it
 * reserves anything of its own (the verify step's challenge attempt).
 */
export function requireOneFactor(input: SecondFactorInput): void {
  const hasCode = present(input.code);
  const hasBackup = present(input.backupCode);
  if (!hasCode && !hasBackup) throw mfaCodeRequired();
  if (hasCode && hasBackup) throw mfaCodeAmbiguous();
}

/**
 * Every check of a second factor (spec §7.2), in one place so the rules hold
 * for sign-in, setup, regenerate, disable and account delete alike:
 *   - exactly one of `code` (TOTP) / `backupCode`, else MFA_CODE_REQUIRED;
 *   - each attempt is RESERVED first - `mfa_failures + 1` in one UPDATE
 *     that a locked account (`mfa_locked_until` ahead) cannot match - so a
 *     burst of parallel guesses gets at most 10 evaluations, and a locked
 *     account is MFA_LOCKED even with the right code; the TOTP replay guard
 *     and the backup-code spend repeat the lock condition in their own
 *     UPDATE, so a right code that lands after a parallel guess set the lock
 *     is refused too;
 *   - TOTP: the seed through decryptStrict (a plaintext or tampered column
 *     never verifies), window ±1, then the replay guard - one UPDATE that
 *     moves `totp_last_step` only forward, so a code is good once;
 *   - backup: the active secret only, normalised, HMAC-peppered, spent by
 *     one UPDATE;
 *   - success resets `mfa_failures` and `mfa_lock_count`; a failure keeps
 *     the reserved count and the 10th locks and resets the count (B3). Each
 *     lock lasts longer than the last (15 min, 1 h, 4 h, then 24 h) until a
 *     correct second factor (finding 4), decided in the same UPDATE.
 * The pepper is resolved in the constructor, so every process that builds
 * SecurityCoreModule (web and worker) refuses to boot without one in
 * production.
 */
@Injectable()
export class SecondFactorService {
  private readonly pepper: string;

  constructor(@Inject(DRIZZLE) private readonly db: DbType) {
    this.pepper = resolveMfaPepper();
  }

  async check(
    userId: string,
    input: SecondFactorInput,
    opts: { secret?: 'active' | 'pending' } = {},
  ): Promise<{ method: SecondFactorMethod; backupCodesRemaining: number }> {
    requireOneFactor(input);

    // Reserve the attempt BEFORE judging the code (batch-2 review ruling 1):
    // one UPDATE counts it as a failure up front and is refused while the
    // account is locked. N parallel guesses therefore get at most
    // MFA_MAX_FAILURES evaluations; a read-then-check let all N through.
    const [reserved] = await this.db
      .update(users)
      .set({ mfaFailures: sql`${users.mfaFailures} + 1` })
      .where(and(eq(users.id, userId), this.notLocked()))
      .returning({
        failures: users.mfaFailures,
        active: users.totpSecretEnc,
        pending: users.totpPendingSecretEnc,
      });
    if (!reserved) return this.refuseLockedOrMissing(userId);
    // More guesses in flight than the cap allows: lock, judge nothing.
    if (reserved.failures > MFA_MAX_FAILURES) return this.lockNow(userId);

    const method: SecondFactorMethod = present(input.code) ? 'totp' : 'backup';
    const ok =
      method === 'totp'
        ? await this.totpOk(
            userId,
            opts.secret === 'pending' ? reserved.pending : reserved.active,
            input.code!,
          )
        : opts.secret !== 'pending' &&
          (await this.spendBackupCode(userId, input.backupCode!));

    if (!ok) return this.fail(userId, reserved.failures);

    await this.db
      .update(users)
      .set({ mfaFailures: 0, mfaLockCount: 0 })
      .where(eq(users.id, userId));
    return {
      method,
      backupCodesRemaining: await this.remaining(userId),
    };
  }

  /** Deletes the user's codes and stores 10 new hashes; returns the display codes. */
  async replaceBackupCodes(
    userId: string,
    executor: SecondFactorExecutor = this.db,
  ): Promise<string[]> {
    const codes = newBackupCodes(BACKUP_CODE_COUNT);
    await executor
      .delete(userBackupCodes)
      .where(eq(userBackupCodes.userId, userId));
    await executor.insert(userBackupCodes).values(
      codes.map((c) => ({
        userId,
        codeHash: hashBackupCode(normalizeBackupCode(c)!, this.pepper),
      })),
    );
    return codes;
  }

  async status(userId: string): Promise<{
    enabled: boolean;
    enabledAt: Date | null;
    backupCodesRemaining: number;
  }> {
    const [user] = await this.db
      .select({ enabledAt: users.totpEnabledAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const enabledAt = user?.enabledAt ?? null;
    return {
      enabled: enabledAt !== null,
      enabledAt,
      backupCodesRemaining: enabledAt ? await this.remaining(userId) : 0,
    };
  }

  /**
   * Two-step sign-in off: every TOTP column nulled, the failure count reset,
   * backup codes and open mfa challenges deleted, trusted devices cleared.
   */
  async clear(
    userId: string,
    executor: SecondFactorExecutor = this.db,
  ): Promise<void> {
    await executor
      .update(users)
      .set(CLEARED_TWO_FACTOR)
      .where(eq(users.id, userId));
    await this.clearRest(userId, executor);
  }

  /**
   * `clear`, but only while two-step sign-in is still the one turned on at
   * `enabledAt` (compared to the millisecond, which is what was written).
   * The "two-step sign-in is on" email's "This wasn't me" link (finding 1):
   * an old link must never turn off a two-step sign-in set up after it. The
   * condition is in the users UPDATE itself; the rest runs only when it
   * matched. Run it in a transaction so a partial clear never commits.
   */
  async clearIfEnabledAt(
    userId: string,
    enabledAt: Date,
    executor: SecondFactorExecutor = this.db,
  ): Promise<boolean> {
    const cleared = await executor
      .update(users)
      .set(CLEARED_TWO_FACTOR)
      .where(
        and(
          eq(users.id, userId),
          sql`date_trunc('milliseconds', ${users.totpEnabledAt}) = ${enabledAt.toISOString()}::timestamptz`,
        ),
      )
      .returning({ id: users.id });
    if (cleared.length === 0) return false;
    await this.clearRest(userId, executor);
    return true;
  }

  /** Backup codes, open mfa challenges and trusted devices of a cleared user. */
  private async clearRest(
    userId: string,
    executor: SecondFactorExecutor,
  ): Promise<void> {
    await executor
      .delete(userBackupCodes)
      .where(eq(userBackupCodes.userId, userId));
    await executor
      .delete(loginChallenges)
      .where(
        and(
          eq(loginChallenges.userId, userId),
          eq(loginChallenges.purpose, 'mfa'),
        ),
      );
    await executor
      .update(knownDevices)
      .set({ mfaTrustedUntil: null })
      .where(eq(knownDevices.userId, userId));
  }

  async isEnabled(userId: string): Promise<boolean> {
    const [user] = await this.db
      .select({ enabledAt: users.totpEnabledAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return !!user?.enabledAt;
  }

  private async totpOk(
    userId: string,
    encrypted: string | null,
    code: string,
  ): Promise<boolean> {
    if (!encrypted) return false;
    let secret: string;
    try {
      secret = decryptStrict(encrypted);
    } catch {
      return false; // a corrupt or plaintext column never verifies
    }
    const step = matchTotp(secret, code);
    if (step === null) return false;
    // Replay guard: moves only forward, so each step is accepted once.
    const moved = await this.db
      .update(users)
      .set({ totpLastStep: step })
      .where(
        and(
          eq(users.id, userId),
          sql`(${users.totpLastStep} IS NULL OR ${users.totpLastStep} < ${step})`,
          // A right code that lands after a parallel guess set the lock is
          // refused in the same statement.
          this.notLocked(),
        ),
      )
      .returning({ id: users.id });
    return moved.length > 0;
  }

  private async spendBackupCode(
    userId: string,
    input: string,
  ): Promise<boolean> {
    const normalized = normalizeBackupCode(input);
    if (!normalized) return false;
    const spent = await this.db
      .update(userBackupCodes)
      .set({ usedAt: sql`now()` })
      .where(
        and(
          eq(userBackupCodes.userId, userId),
          eq(userBackupCodes.codeHash, hashBackupCode(normalized, this.pepper)),
          isNull(userBackupCodes.usedAt),
          // Never spent while the account is locked (same statement).
          sql`EXISTS (SELECT 1 FROM ${users} WHERE ${users.id} = ${userId} AND (${users.mfaLockedUntil} IS NULL OR ${users.mfaLockedUntil} <= now()))`,
        ),
      )
      .returning({ id: userBackupCodes.id });
    return spent.length > 0;
  }

  /**
   * The code was wrong; the failure was already counted by the reservation.
   * The 10th consecutive one locks (lockNow). Always throws: MFA_LOCKED
   * when the account is (now) locked, else MFA_CODE_INVALID.
   */
  private async fail(userId: string, failures: number): Promise<never> {
    if (failures >= MFA_MAX_FAILURES) return this.lockNow(userId);
    const lockedFor = await this.lockedFor(userId);
    if (lockedFor !== null && lockedFor > 0) throw mfaLocked(lockedFor);
    throw mfaCodeInvalid();
  }

  /**
   * Sets the lock and resets the failure count, in one UPDATE. A lock still
   * running (a parallel guess set it) is kept and NOT counted again, so a
   * burst escalates once. Otherwise the lock lasts by `mfa_lock_count` (15
   * min, 1 h, 4 h, then 24 h) and the count goes up; the SET reads the old
   * row, so both CASEs judge the same lock.
   */
  private async lockNow(userId: string): Promise<never> {
    const running = sql`${users.mfaLockedUntil} > now()`;
    const [row] = await this.db
      .update(users)
      .set({
        mfaLockedUntil: sql`CASE WHEN ${running} THEN ${users.mfaLockedUntil} ELSE now() + ${nextLockInterval} END`,
        mfaLockCount: sql`CASE WHEN ${running} THEN ${users.mfaLockCount} ELSE ${users.mfaLockCount} + 1 END`,
        mfaFailures: 0,
      })
      .where(eq(users.id, userId))
      .returning({
        lockedFor: sql<number>`extract(epoch FROM (${users.mfaLockedUntil} - now()))::float`,
      });
    throw mfaLocked(
      Math.max(1, Number(row?.lockedFor ?? MFA_LOCK_MINUTES_BY_COUNT[0] * 60)),
    );
  }

  /** The reservation matched no row: the account is locked, or it is gone. */
  private async refuseLockedOrMissing(userId: string): Promise<never> {
    const lockedFor = await this.lockedFor(userId);
    if (lockedFor === null) throw mfaCodeInvalid();
    // Expired between the two statements: still a refusal, retry in 1 s.
    throw mfaLocked(Math.max(1, lockedFor));
  }

  /** Seconds until the lock lifts (<= 0 when not locked); null when no user. */
  private async lockedFor(userId: string): Promise<number | null> {
    const [row] = await this.db
      .select({
        lockedFor: sql<
          number | null
        >`coalesce(extract(epoch FROM (${users.mfaLockedUntil} - now()))::float, 0)`,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row ? Number(row.lockedFor) : null;
  }

  private notLocked() {
    return sql`(${users.mfaLockedUntil} IS NULL OR ${users.mfaLockedUntil} <= now())`;
  }

  private async remaining(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(userBackupCodes)
      .where(
        and(eq(userBackupCodes.userId, userId), isNull(userBackupCodes.usedAt)),
      );
    return Number(row?.n ?? 0);
  }
}
