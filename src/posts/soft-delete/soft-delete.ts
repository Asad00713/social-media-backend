import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { posts, workspace } from '../../drizzle/schema';

/**
 * How long a soft-deleted row is kept before it is purged for good.
 *
 * Matches the media library's recycle bin, so the product has one answer to
 * "how long do I have to undo this?" rather than one per feature.
 */
export const SOFT_DELETE_RETENTION_DAYS = 30;

/**
 * The filter every ordinary read of `posts` must carry.
 *
 * ```ts
 * .where(and(eq(posts.workspaceId, id), livePosts()))
 * ```
 *
 * A read that omits it shows the author a post they deleted. The regression
 * test in posts-reads-filter-deleted.spec.ts discovers read sites from disk
 * and fails on one that neither filters nor appears in the exemption list.
 */
export function livePosts(): SQL {
  return isNull(posts.deletedAt);
}

/** The same, for `workspace`. */
export function liveWorkspaces(): SQL {
  return isNull(workspace.deletedAt);
}

/**
 * The filter every read on a PUBLISHING path must carry on top of
 * `livePosts()`: the post's workspace must still exist.
 *
 * Deleting a workspace is a soft delete, and it marks only the `workspace`
 * row - posts keep `deleted_at IS NULL` deliberately, because the 30-day
 * window exists so the whole workspace can be brought back intact. So a
 * scheduled post in a deleted workspace is still a live post, and
 * `livePosts()` alone happily selects it.
 *
 * For a read answering a user's request that is harmless: the routing already
 * scopes it to a workspace they can reach, and a deleted one is unreachable.
 * The BACKGROUND paths are the problem, because nothing scopes them - the
 * publish processor, the reconciler, the stranded sweeper and the repeat
 * series all scan `posts` globally on a timer. Without this filter a workspace
 * someone deleted goes on PUBLISHING TO SOCIAL MEDIA in their name until the
 * purge removes it 30 days later - and the reconciler actively re-arms the
 * jobs that would otherwise have drained out of Redis.
 *
 * A correlated EXISTS rather than a join: these queries have different shapes
 * (one aggregates, one selects a column list, one is a single-row lookup), and
 * a join would change what each returns and how its callers read it. This
 * drops into an existing `and(...)` unchanged.
 *
 * `workspace_id` is NOT NULL on `posts`, so there is no orphan case to decide.
 */
export function liveWorkspacePosts(): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${workspace}
    WHERE ${workspace.id} = ${posts.workspaceId}
      AND ${workspace.deletedAt} IS NULL
  )`;
}

/**
 * The filter as raw SQL, for the handful of reads written as raw SQL rather
 * than through the query builder. `alias` is the table's alias in that query
 * (`p` in `FROM posts p`), empty for an unaliased table.
 */
export function livePostsSql(alias = ''): SQL {
  const prefix = alias ? `${alias}.` : '';
  return sql.raw(`${prefix}deleted_at IS NULL`);
}

/** The cutoff a purge job deletes before. */
export function purgeCutoff(
  now: Date = new Date(),
  days: number = SOFT_DELETE_RETENTION_DAYS,
): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Is this workspace still live? For a path that must stop BEFORE it writes.
 *
 * `liveWorkspacePosts()` filters a read of `posts`, which is the right shape
 * when the question is "may I act on this existing row". It is the wrong shape
 * when the work begins by CREATING a row: a repeating series inserts the next
 * post and enqueues it, and a filter on a later read cannot prevent either.
 * Guarding the conflict-retry branch there looked like a fix and stopped
 * nothing, because the normal path never enters it.
 *
 * So the engines that materialise posts ask this first, and return early.
 *
 * Takes its executor as `Pick<DbType, 'select'>` so a caller inside a
 * transaction can pass `tx` and be answered on the same connection - the
 * distinction the usage-counter work turned on, where a read on the pool sat
 * outside the advisory lock meant to protect it.
 */
export async function isWorkspaceLive(
  executor: Pick<DbType, 'select'>,
  workspaceId: string,
): Promise<boolean> {
  // No `.limit(1)`: `workspace.id` is the primary key, so this matches at
  // most one row anyway, and every test fake in the callers' suites would
  // otherwise need a `limit` on its chain.
  const rows = await executor
    .select({ id: workspace.id })
    .from(workspace)
    .where(and(eq(workspace.id, workspaceId), liveWorkspaces()));
  return rows.length > 0;
}
