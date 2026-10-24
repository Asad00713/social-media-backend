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

/**
 * SQL twin of `derivePostStatus(...) === 'partially_published'`. Only a stored
 * `published` or `failed` row is re-derived from its targets (every other
 * stored value is taken as is). A target is published when EITHER status field
 * says so; it is failed when it is not published and either field says failed.
 */
export function isPartlyPublishedSql(): SQL {
  return sql`(
    ${posts.status} = 'partially_published'
    OR (
      ${posts.status} IN ('published', 'failed')
      AND jsonb_typeof(${posts.targets}) = 'array'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(${posts.targets}) AS t
        WHERE t->>'status' = 'published' OR t->>'publishStatus' = 'published'
      )
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(${posts.targets}) AS t
        WHERE COALESCE(t->>'status', '') <> 'published'
          AND COALESCE(t->>'publishStatus', '') <> 'published'
          AND (t->>'status' = 'failed' OR t->>'publishStatus' = 'failed')
      )
    )
  )`;
}

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
