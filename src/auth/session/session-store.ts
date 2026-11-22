import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { knownDevices } from '../../drizzle/schema/known-devices.schema';
import {
  userSessions,
  type DeviceType,
  type UserSession,
} from '../../drizzle/schema/user-sessions.schema';
import { users } from '../../drizzle/schema/users.schema';
import { SessionCheck } from './session-check';

/** A session ends after this many days without a refresh (spec §7.1). */
export const SESSION_IDLE_DAYS = 30;
/** Revoked or expired rows older than this are deleted on the next sign-in (B8). */
const SESSION_RETENTION_DAYS = 90;

/** The db or a transaction on it: every write can join the caller's transaction. */
export type SessionExecutor = Pick<
  DbType,
  'select' | 'insert' | 'update' | 'delete' | 'execute'
>;

export interface CreateSessionInput {
  userId: string;
  deviceHash: string | null;
  label: string;
  deviceType: DeviceType;
  ip: string | null;
  /**
   * When the sign-in this row stands for happened; the database default
   * (now) when absent. Set for a row made for a pre-deploy token (see
   * ReissueOptions.legacyIssuedAt).
   */
  createdAt?: Date;
}

// Every sid we sign is a uuid. Anything else (a forged or legacy payload)
// would make Postgres throw 22P02 and turn a 401 into a 500.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && UUID.test(s);

const idleExpiry = sql`now() + make_interval(days => ${SESSION_IDLE_DAYS})`;
const live = () =>
  and(isNull(userSessions.revokedAt), gt(userSessions.expiresAt, sql`now()`));

/**
 * The `user_sessions` rows behind every token's `sid` (spec §7.1).
 *
 * A token WITH a `sid` is judged by its row alone; the
 * `users.sessions_revoked_at` floor judges only legacy tokens without one
 * (B1). That is why every write of the floor lives here, next to the row
 * revokes: "log out of other sessions" must kill legacy tokens (floor) while
 * keeping the caller's own row, and "log out everywhere" must do both.
 *
 * Every revoke forgets the revoked sids in this process's SessionCheck cache,
 * so a revoke is instant here and at most 30 s late on other instances.
 */
@Injectable()
export class SessionStore {
  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    @Inject(forwardRef(() => SessionCheck))
    private readonly check: SessionCheck,
  ) {}

  /** A new session row, idle-expiring in 30 days. Also prunes the user's old rows (B8). */
  async create(
    input: CreateSessionInput,
    executor: SessionExecutor = this.db,
  ): Promise<{ id: string; expiresAt: Date }> {
    await this.prune(input.userId, executor);
    const [row] = await executor
      .insert(userSessions)
      .values({
        userId: input.userId,
        deviceHash: input.deviceHash,
        label: input.label,
        deviceType: input.deviceType,
        ip: input.ip,
        expiresAt: idleExpiry,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      })
      .returning({ id: userSessions.id, expiresAt: userSessions.expiresAt });
    return row;
  }

  /**
   * `create`, but only while the user still has two-step sign-in OFF; null
   * (and no row) once it is on. For a sign-in that read "2FA off" and so
   * was not challenged (final review finding 6): a 2FA enable committing in
   * between would otherwise leave this session alive without ever passing
   * the second factor, because enable's revokeOthers ran before the row
   * existed.
   *
   * One statement, and the users row is read FOR SHARE: an enable updates
   * that row (totp_enabled_at) BEFORE its revokeOthers in the same
   * transaction, so either this insert waits for the enable to commit and
   * then re-checks the row (READ COMMITTED re-evaluates a locked row: 2FA
   * is on, nothing is inserted), or it commits first and the enable's
   * UPDATE waits for it, and the revokeOthers that follows sees and
   * revokes the new row. A plain SELECT would read the pre-enable row
   * without waiting and could insert after revokeOthers ran.
   */
  async createIfTwoFactorOff(
    input: CreateSessionInput,
    executor: SessionExecutor = this.db,
  ): Promise<{ id: string; expiresAt: Date } | null> {
    await this.prune(input.userId, executor);
    const createdAt = input.createdAt
      ? sql`${input.createdAt.toISOString()}::timestamptz`
      : sql`now()`;
    const result = await executor.execute<{
      id: string;
      expires_at: Date | string;
    }>(sql`
      INSERT INTO ${userSessions}
        (user_id, device_hash, label, device_type, ip, expires_at, created_at)
      SELECT u.id, ${input.deviceHash}, ${input.label}, ${input.deviceType},
             ${input.ip}, ${idleExpiry}, ${createdAt}
        FROM ${users} u
       WHERE u.id = ${input.userId}
         AND u.totp_enabled_at IS NULL
         FOR SHARE OF u
      RETURNING id, expires_at`);
    const row = result.rows[0];
    return row ? { id: row.id, expiresAt: new Date(row.expires_at) } : null;
  }

  /** Revoked or expired rows older than 90 days go on the next sign-in (B8). */
  private async prune(
    userId: string,
    executor: SessionExecutor,
  ): Promise<void> {
    const cutoff = sql`now() - make_interval(days => ${SESSION_RETENTION_DAYS})`;
    await executor
      .delete(userSessions)
      .where(
        and(
          eq(userSessions.userId, userId),
          or(
            lt(userSessions.revokedAt, cutoff),
            lt(userSessions.expiresAt, cutoff),
          ),
        ),
      );
  }

  /** The GeoIP country, written just after the row (the lookup is detached). */
  async setCountry(sid: string, country: string | null): Promise<void> {
    if (!isUuid(sid)) return;
    await this.db
      .update(userSessions)
      .set({ country })
      .where(eq(userSessions.id, sid));
  }

  /**
   * A refresh: marks the session used and pushes its idle expiry 30 days
   * out. False when the row is not this user's, revoked or already idle —
   * the caller must then mint nothing.
   */
  async touch(sid: string, userId: string): Promise<boolean> {
    if (!isUuid(sid) || !isUuid(userId)) return false;
    const rows = await this.db
      .update(userSessions)
      .set({ lastUsedAt: sql`now()`, expiresAt: idleExpiry })
      .where(
        and(eq(userSessions.id, sid), eq(userSessions.userId, userId), live()),
      )
      .returning({ id: userSessions.id });
    return rows.length > 0;
  }

  /** Uncached: is this the user's session, not revoked, not idle? */
  async isLive(sid: string, userId: string): Promise<boolean> {
    if (!isUuid(sid) || !isUuid(userId)) return false;
    const rows = await this.db
      .select({ id: userSessions.id })
      .from(userSessions)
      .where(
        and(eq(userSessions.id, sid), eq(userSessions.userId, userId), live()),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** When the live session started (the re-auth window reads this, not `iat`). */
  async createdAt(sid: string, userId: string): Promise<Date | null> {
    if (!isUuid(sid) || !isUuid(userId)) return null;
    const [row] = await this.db
      .select({ createdAt: userSessions.createdAt })
      .from(userSessions)
      .where(
        and(eq(userSessions.id, sid), eq(userSessions.userId, userId), live()),
      )
      .limit(1);
    return row?.createdAt ?? null;
  }

  /** The user's live sessions, most recently used first. */
  async listLive(userId: string): Promise<UserSession[]> {
    if (!isUuid(userId)) return [];
    return this.db
      .select()
      .from(userSessions)
      .where(and(eq(userSessions.userId, userId), live()))
      .orderBy(desc(userSessions.lastUsedAt));
  }

  /**
   * Revokes one of the user's live sessions (Sessions -> revoke, and logout)
   * and stops trusting its browser for two-step sign-in (final review
   * finding 2): revoking "Chrome on Linux, Romania" is what a person does to
   * kick an attacker out, and a 30-day trust left behind would let the
   * password alone sign that browser straight back in. One statement, so
   * the revoke and the trust clear commit together. Only this user's
   * known_devices row with the session's device_hash; a row with no
   * device_hash clears nothing. False when there is no live session to
   * revoke (and then no trust is touched).
   */
  async revoke(
    userId: string,
    sid: string,
    executor: SessionExecutor = this.db,
  ): Promise<boolean> {
    if (!isUuid(sid) || !isUuid(userId)) return false;
    const result = await executor.execute<{ id: string }>(sql`
      WITH revoked AS (
        UPDATE ${userSessions}
           SET revoked_at = now()
         WHERE id = ${sid}
           AND user_id = ${userId}
           AND revoked_at IS NULL
           AND expires_at > now()
        RETURNING id, device_hash
      ), untrusted AS (
        UPDATE ${knownDevices}
           SET mfa_trusted_until = NULL
         WHERE user_id = ${userId}
           AND device_hash IN (SELECT device_hash FROM revoked)
      )
      SELECT id FROM revoked`);
    const ids = result.rows.map((r) => r.id);
    this.forgetAll(ids);
    return ids.length > 0;
  }

  /**
   * "Log out of other sessions": revokes every live row except `keepSid`,
   * moves the `sessions_revoked_at` floor (so legacy sid-less tokens die
   * too, B1) and clears the user's trusted devices. Returns the rows revoked.
   */
  revokeOthers(
    userId: string,
    keepSid: string | null,
    executor: SessionExecutor = this.db,
  ): Promise<number> {
    return this.revokeMany(userId, keepSid, executor);
  }

  /** "Log out everywhere": `revokeOthers` keeping nothing. */
  revokeAll(
    userId: string,
    executor: SessionExecutor = this.db,
  ): Promise<number> {
    return this.revokeMany(userId, null, executor);
  }

  private async revokeMany(
    userId: string,
    keepSid: string | null,
    executor: SessionExecutor,
  ): Promise<number> {
    if (!isUuid(userId)) return 0;
    const keep = isUuid(keepSid) ? keepSid : null;
    const rows = await executor
      .update(userSessions)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(userSessions.userId, userId),
          live(),
          keep ? ne(userSessions.id, keep) : undefined,
        ),
      )
      .returning({ id: userSessions.id });
    await executor
      .update(users)
      .set({ sessionsRevokedAt: sql`now()` })
      .where(eq(users.id, userId));
    await this.clearTrust(userId, executor);
    this.forgetAll(rows.map((r) => r.id));
    return rows.length;
  }

  /**
   * Every trusted device of the user must pass two-step sign-in again (spec
   * §7.2: trust is cleared on revoke-others and on a password change, even
   * one that keeps the other sessions).
   */
  async clearTrust(
    userId: string,
    executor: SessionExecutor = this.db,
  ): Promise<void> {
    if (!isUuid(userId)) return;
    await executor
      .update(knownDevices)
      .set({ mfaTrustedUntil: null })
      .where(eq(knownDevices.userId, userId));
  }

  private forgetAll(ids: string[]): void {
    for (const id of ids) this.check.forget(id);
  }
}
