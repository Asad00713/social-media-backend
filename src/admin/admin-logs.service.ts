import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import { errorLogs, type ErrorLog, type LogLevel } from '../drizzle/schema';

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
export class AdminLogsService {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  // error_logs.created_at is timestamptz — cast the cursor as timestamptz and
  // compare at millisecond precision (same keyset fix as AdminActivityService,
  // which avoids the boundary-row duplicate from ms-vs-microsecond precision).
  private keysetBefore(cursor?: string): SQL | undefined {
    const decoded = decodeCursor(cursor);
    if (!decoded) return undefined;
    const cursorTs = sql`${decoded.createdAt}::timestamptz`;
    const colMs = sql`date_trunc('milliseconds', ${errorLogs.createdAt})`;
    return or(
      lt(colMs, cursorTs),
      and(eq(colMs, cursorTs), lt(errorLogs.id, decoded.id)),
    );
  }

  async getLogs(opts: {
    level?: LogLevel;
    context?: string;
    search?: string;
    since?: string;
    cursor?: string;
  }): Promise<{ items: ErrorLog[]; nextCursor: string | null }> {
    const conditions: SQL[] = [];
    const keyset = this.keysetBefore(opts.cursor);
    if (keyset) conditions.push(keyset);
    if (opts.level) conditions.push(eq(errorLogs.level, opts.level));
    if (opts.context) conditions.push(eq(errorLogs.context, opts.context));
    if (opts.search?.trim())
      conditions.push(ilike(errorLogs.message, `%${opts.search.trim()}%`));
    if (opts.since)
      conditions.push(gte(errorLogs.createdAt, new Date(opts.since)));

    const rows = await this.db
      .select()
      .from(errorLogs)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(errorLogs.createdAt), desc(errorLogs.id))
      .limit(PAGE_SIZE + 1);

    if (rows.length <= PAGE_SIZE) return { items: rows, nextCursor: null };
    const items = rows.slice(0, PAGE_SIZE);
    return { items, nextCursor: encodeCursor(items[items.length - 1]) };
  }

  async getStats(): Promise<{
    total24h: number;
    byLevel: { level: string; count: number }[];
    topContexts: { context: string | null; count: number }[];
  }> {
    const since = sql`now() - interval '24 hours'`;
    const [byLevel, topContexts] = await Promise.all([
      this.db
        .select({ level: errorLogs.level, count: sql<number>`count(*)::int` })
        .from(errorLogs)
        .where(gte(errorLogs.createdAt, since))
        .groupBy(errorLogs.level),
      this.db
        .select({
          context: errorLogs.context,
          count: sql<number>`count(*)::int`,
        })
        .from(errorLogs)
        .where(gte(errorLogs.createdAt, since))
        .groupBy(errorLogs.context)
        .orderBy(desc(sql`count(*)`))
        .limit(8),
    ]);
    const total24h = byLevel.reduce((s, r) => s + r.count, 0);
    return { total24h, byLevel, topContexts };
  }
}
