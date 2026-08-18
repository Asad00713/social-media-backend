import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, gte, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import {
  adminAuditLogs,
  users,
  type AdminAuditLog,
  type AuditAction,
  type AuditTargetType,
} from '../drizzle/schema';

export interface AuditRecordEntry {
  action: AuditAction;
  actorId: string;
  targetType: AuditTargetType;
  targetId: string;
  targetLabel?: string | null;
  reason?: string | null;
  note?: string | null;
  metadata?: Record<string, unknown>;
}

const MAX_NOTE = 5000;
const MAX_LABEL = 255;
const PAGE_SIZE = 50;

function encodeCursor(row: { createdAt: Date | string; id: string }): string {
  const created =
    row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : String(row.createdAt);
  return `${created}_${row.id}`;
}
function decodeCursor(
  cursor?: string,
): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  const at = cursor.lastIndexOf('_');
  if (at <= 0) return null;
  return { createdAt: cursor.slice(0, at), id: cursor.slice(at + 1) };
}

@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /**
   * Write one audit row. Call AFTER the underlying mutation has succeeded — a
   * failed action must not leave an audit row. Never throws and never rolls
   * back the caller's action: a write failure is logged as a warning (which
   * itself lands in error_logs) and swallowed.
   */
  async record(entry: AuditRecordEntry): Promise<void> {
    try {
      const actor = await this.db.query.users.findFirst({
        where: eq(users.id, entry.actorId),
        columns: { email: true },
      });

      await this.db.insert(adminAuditLogs).values({
        action: entry.action,
        actorId: entry.actorId,
        actorEmail: actor?.email ?? null,
        targetType: entry.targetType,
        targetId: entry.targetId,
        targetLabel: entry.targetLabel?.slice(0, MAX_LABEL) ?? null,
        reason: entry.reason ?? null,
        note: entry.note?.slice(0, MAX_NOTE) ?? null,
        metadata: entry.metadata ?? {},
      });
    } catch (err) {
      this.logger.warn(
        `Failed to write audit log for ${entry.action} on ${entry.targetType}:${entry.targetId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // admin_audit_logs.created_at is timestamptz — cast the cursor as timestamptz
  // and compare at millisecond precision (same keyset fix as AdminLogsService /
  // AdminActivityService, which avoids the boundary-row duplicate from
  // ms-vs-microsecond precision).
  private keysetBefore(cursor?: string): SQL | undefined {
    const decoded = decodeCursor(cursor);
    if (!decoded) return undefined;
    const cursorTs = sql`${decoded.createdAt}::timestamptz`;
    const colMs = sql`date_trunc('milliseconds', ${adminAuditLogs.createdAt})`;
    return or(
      lt(colMs, cursorTs),
      and(eq(colMs, cursorTs), lt(adminAuditLogs.id, decoded.id)),
    );
  }

  async getAudit(opts: {
    action?: AuditAction;
    targetType?: AuditTargetType;
    actorId?: string;
    search?: string;
    since?: string;
    cursor?: string;
  }): Promise<{ items: AdminAuditLog[]; nextCursor: string | null }> {
    const conditions: SQL[] = [];
    const keyset = this.keysetBefore(opts.cursor);
    if (keyset) conditions.push(keyset);
    if (opts.action) conditions.push(eq(adminAuditLogs.action, opts.action));
    if (opts.targetType)
      conditions.push(eq(adminAuditLogs.targetType, opts.targetType));
    if (opts.actorId) conditions.push(eq(adminAuditLogs.actorId, opts.actorId));
    if (opts.search?.trim()) {
      const term = `%${opts.search.trim()}%`;
      conditions.push(
        or(
          ilike(adminAuditLogs.targetLabel, term),
          ilike(adminAuditLogs.note, term),
        )!,
      );
    }
    if (opts.since)
      conditions.push(gte(adminAuditLogs.createdAt, new Date(opts.since)));

    const rows = await this.db
      .select()
      .from(adminAuditLogs)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(adminAuditLogs.createdAt), desc(adminAuditLogs.id))
      .limit(PAGE_SIZE + 1);

    if (rows.length <= PAGE_SIZE) return { items: rows, nextCursor: null };
    const items = rows.slice(0, PAGE_SIZE);
    return { items, nextCursor: encodeCursor(items[items.length - 1]) };
  }

  async getStats(): Promise<{
    total24h: number;
    total7d: number;
    byAction: { action: string; count: number }[];
    topActors: { actorId: string; actorEmail: string | null; count: number }[];
  }> {
    const since24h = sql`now() - interval '24 hours'`;
    const since7d = sql`now() - interval '7 days'`;
    const [total24hRows, byAction, topActors] = await Promise.all([
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(adminAuditLogs)
        .where(gte(adminAuditLogs.createdAt, since24h)),
      this.db
        .select({
          action: adminAuditLogs.action,
          count: sql<number>`count(*)::int`,
        })
        .from(adminAuditLogs)
        .where(gte(adminAuditLogs.createdAt, since7d))
        .groupBy(adminAuditLogs.action)
        .orderBy(desc(sql`count(*)`)),
      this.db
        .select({
          actorId: adminAuditLogs.actorId,
          actorEmail: adminAuditLogs.actorEmail,
          count: sql<number>`count(*)::int`,
        })
        .from(adminAuditLogs)
        .where(gte(adminAuditLogs.createdAt, since7d))
        .groupBy(adminAuditLogs.actorId, adminAuditLogs.actorEmail)
        .orderBy(desc(sql`count(*)`))
        .limit(8),
    ]);
    const total7d = byAction.reduce((s, r) => s + r.count, 0);
    return {
      total24h: total24hRows[0]?.count ?? 0,
      total7d,
      byAction,
      topActors,
    };
  }
}
