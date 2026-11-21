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
    const cutoff = sql`now() - make_interval(days => ${SESSION_RETENTION_DAYS})`;
    await executor
      .delete(userSessions)
      .where(
        and(
          eq(userSessions.userId, input.userId),
          or(
            lt(userSessions.revokedAt, cutoff),
            lt(userSessions.expiresAt, cutoff),
          ),
        ),
      );
    const [row] = await executor
      .insert(userSessions)
      .values({
        userId: input.userId,
        deviceHash: input.deviceHash,
        label: input.label,
        deviceType: input.deviceType,
        ip: input.ip,
        expiresAt: idleExpiry,
      })
      .returning({ id: userSessions.id, expiresAt: userSessions.expiresAt });
    return row;
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

  /** Revokes one of the user's live sessions. False when there is none to revoke. */
  async revoke(
    userId: string,
    sid: string,
    executor: SessionExecutor = this.db,
  ): Promise<boolean> {
    if (!isUuid(sid) || !isUuid(userId)) return false;
    const rows = await executor
      .update(userSessions)
      .set({ revokedAt: sql`now()` })
      .where(
        and(eq(userSessions.id, sid), eq(userSessions.userId, userId), live()),
      )
      .returning({ id: userSessions.id });
    this.forgetAll(rows.map((r) => r.id));
    return rows.length > 0;
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
    await executor
      .update(knownDevices)
      .set({ mfaTrustedUntil: null })
      .where(eq(knownDevices.userId, userId));
    this.forgetAll(rows.map((r) => r.id));
    return rows.length;
  }

  private forgetAll(ids: string[]): void {
    for (const id of ids) this.check.forget(id);
  }
}
