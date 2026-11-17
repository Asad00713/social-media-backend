import { isNull, sql, type SQL } from 'drizzle-orm';
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
