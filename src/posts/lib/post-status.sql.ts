import { and, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { posts } from '../../drizzle/schema/posts.schema';

/**
 * The instant a post occupies on the calendar. A post published immediately
 * has no `scheduled_at`, so `published_at` comes first.
 */
export const occurredAtSql: SQL = sql`COALESCE(${posts.publishedAt}, ${posts.scheduledAt})`;

/** Everything except `draft`: a draft has no date to place on a grid. */
export const NON_DRAFT_STATUSES = [
  'scheduled',
  'publishing',
  'published',
  'failed',
  'partially_published',
] as const;

export function calendarRangeWhere(
  workspaceId: string,
  from: Date,
  to: Date,
): SQL {
  return and(
    eq(posts.workspaceId, workspaceId),
    inArray(posts.status, [...NON_DRAFT_STATUSES]),
    gte(occurredAtSql, from),
    lte(occurredAtSql, to),
  ) as SQL;
}
