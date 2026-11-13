import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { posts, type PostStatus } from '../../drizzle/schema/posts.schema';

export interface WorkspacePostsOptions {
  status?: PostStatus;
  channelId?: string;
  limit?: number;
  offset?: number;
}

export const DEFAULT_WORKSPACE_POSTS_LIMIT = 50;

/**
 * A post that has a target on this channel. Every writer stores the target's
 * `channelId` as a string, but a hand-written or very old row could carry a
 * number, so both spellings are matched. Containment (`@>`) is what the
 * `posts_targets_gin_idx` (jsonb_path_ops) index serves. `targets` is the
 * column as the caller's query names it (raw SQL may alias `posts`).
 */
export function hasTargetOnChannelSql(
  channelId: string | number,
  targets: SQL = sql`${posts.targets}`,
): SQL {
  const asText = String(channelId);
  const asNumber = Number(asText);
  const textMatch = JSON.stringify([{ channelId: asText }]);
  if (!Number.isSafeInteger(asNumber)) {
    return sql`${targets} @> ${textMatch}::jsonb`;
  }
  const numberMatch = JSON.stringify([{ channelId: asNumber }]);
  return sql`(${targets} @> ${textMatch}::jsonb OR ${targets} @> ${numberMatch}::jsonb)`;
}

/**
 * `GET /posts/workspaces/:workspaceId`: one page of a workspace's posts,
 * newest first, and the unpaged total. The channel filter is part of the SQL,
 * so it narrows both the page and the total (it used to run in JS on the
 * page after LIMIT/OFFSET, which emptied pages and left `total` unfiltered).
 */
export async function listWorkspacePosts(
  db: Pick<DbType, 'select'>,
  workspaceId: string,
  options: WorkspacePostsOptions = {},
): Promise<{ posts: (typeof posts.$inferSelect)[]; total: number }> {
  const conditions: SQL[] = [
    eq(posts.workspaceId, workspaceId),
    // Campaign-materialised posts stay off the normal list (the calendar
    // still shows them). Materialised means "has a slot": a post the
    // composer filed under a campaign (metadata.campaignId alone) is still
    // an ordinary post that Maestro and the chatbot must be able to list.
    sql`(${posts.metadata} -> 'campaignSlot') is null`,
  ];
  if (options.status) conditions.push(eq(posts.status, options.status));
  if (options.channelId !== undefined && options.channelId !== '') {
    conditions.push(hasTargetOnChannelSql(options.channelId));
  }
  const where = and(...conditions);

  const [[{ count }], rows] = await Promise.all([
    db
      .select({ count: sql<string>`count(*)` })
      .from(posts)
      .where(where),
    db
      .select()
      .from(posts)
      .where(where)
      .orderBy(desc(posts.createdAt), desc(posts.id))
      .limit(options.limit || DEFAULT_WORKSPACE_POSTS_LIMIT)
      .offset(options.offset || 0),
  ]);

  return { posts: rows, total: Number(count) };
}
