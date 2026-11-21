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
export const MFA_LOCK_MINUTES = 15;

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

const present = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0;

/**
 * Every check of a second factor (spec §7.2), in one place so the rules hold
 * for sign-in, setup, regenerate, disable and account delete alike:
 *   - exactly one of `code` (TOTP) / `backupCode`, else MFA_CODE_REQUIRED;
 *   - a locked account (`mfa_locked_until` ahead) is MFA_LOCKED, even with
 *     the right code;
 *   - TOTP: the seed through decryptStrict (a plaintext or tampered column
 *     never verifies), window ±1, then the replay guard - one UPDATE that
 *     moves `totp_last_step` only forward, so a code is good once;
 *   - backup: the active secret only, normalised, HMAC-peppered, spent by
 *     one UPDATE;
 *   - success resets `mfa_failures`; a failure adds one atomically and the
 *     10th locks for 15 minutes and resets the count (B3).
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
    const hasCode = present(input.code);
    const hasBackup = present(input.backupCode);
    if (!hasCode && !hasBackup) throw mfaCodeRequired();
    if (hasCode && hasBackup) throw mfaCodeAmbiguous();

    const [user] = await this.db
      .select({
        active: users.totpSecretEnc,
        pending: users.totpPendingSecretEnc,
        lockedFor: sql<
          number | null
        >`extract(epoch FROM (${users.mfaLockedUntil} - now()))::float`,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) throw mfaCodeInvalid();
    if (user.lockedFor !== null && Number(user.lockedFor) > 0) {
      throw mfaLocked(Number(user.lockedFor));
    }

    const method: SecondFactorMethod = hasCode ? 'totp' : 'backup';
    const ok = hasCode
      ? await this.totpOk(
          userId,
          opts.secret === 'pending' ? user.pending : user.active,
          input.code!,
        )
      : opts.secret !== 'pending' &&
        (await this.spendBackupCode(userId, input.backupCode!));

    if (!ok) return this.fail(userId);

    await this.db
      .update(users)
      .set({ mfaFailures: 0 })
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
      .set({
        totpSecretEnc: null,
        totpPendingSecretEnc: null,
        totpEnabledAt: null,
        totpLastStep: null,
        mfaFailures: 0,
        mfaLockedUntil: null,
      })
      .where(eq(users.id, userId));
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
        ),
      )
      .returning({ id: userBackupCodes.id });
    return spent.length > 0;
  }

  /** One more failure, atomically; the 10th locks for 15 minutes. Always throws. */
  private async fail(userId: string): Promise<never> {
    const reaches = sql`${users.mfaFailures} + 1 >= ${MFA_MAX_FAILURES}`;
    const [row] = await this.db
      .update(users)
      .set({
        mfaFailures: sql`CASE WHEN ${reaches} THEN 0 ELSE ${users.mfaFailures} + 1 END`,
        mfaLockedUntil: sql`CASE WHEN ${reaches} THEN now() + make_interval(mins => ${MFA_LOCK_MINUTES}) ELSE ${users.mfaLockedUntil} END`,
      })
      .where(eq(users.id, userId))
      .returning({
        lockedFor: sql<
          number | null
        >`extract(epoch FROM (${users.mfaLockedUntil} - now()))::float`,
      });
    if (row && row.lockedFor !== null && Number(row.lockedFor) > 0) {
      throw mfaLocked(Number(row.lockedFor));
    }
    throw mfaCodeInvalid();
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
