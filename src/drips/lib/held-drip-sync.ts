import { and, eq, sql } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import {
  dripCampaignHistory,
  dripCampaigns,
  dripPosts,
} from '../../drizzle/schema/drips.schema';
import type { posts } from '../../drizzle/schema/posts.schema';

const OUTCOMES: ReadonlySet<string> = new Set([
  'published',
  'partially_published',
  'failed',
]);

/**
 * Record the outcome of a drip occurrence that was HELD for a paused channel.
 *
 * DripProcessor publishes an occurrence at once and records the result
 * itself. When the channel is paused the post is held instead (it becomes
 * `scheduled`, the drip post `scheduled`), and it goes out later, from the
 * resume's publish job - where the processor is not around to see it. This
 * is that missing step, mirroring the processor's own bookkeeping: only a
 * fully published post counts as published (and as a completed occurrence);
 * anything else marks the drip post failed.
 *
 * A no-op for every post that is not a held drip occurrence: the UPDATE only
 * matches a drip post still `scheduled` AND linked to this post, which is
 * also what makes it safe to run more than once.
 */
export async function syncHeldDripPost(
  db: Pick<DbType, 'update' | 'insert'>,
  post: Pick<
    typeof posts.$inferSelect,
    'id' | 'status' | 'metadata' | 'lastError'
  >,
): Promise<boolean> {
  const meta = (post.metadata ?? {}) as {
    dripPostId?: unknown;
    dripCampaignId?: unknown;
  };
  if (
    typeof meta.dripPostId !== 'string' ||
    typeof meta.dripCampaignId !== 'string' ||
    !OUTCOMES.has(post.status)
  ) {
    return false;
  }
  const dripPostId = meta.dripPostId;
  const campaignId = meta.dripCampaignId;
  const published = post.status === 'published';
  const now = new Date();

  const [row] = await db
    .update(dripPosts)
    .set(
      published
        ? { status: 'published', publishedAt: now, updatedAt: now }
        : {
            status: 'failed',
            lastError: post.lastError ?? 'Publishing failed',
            lastErrorAt: now,
            updatedAt: now,
          },
    )
    .where(
      and(
        eq(dripPosts.id, dripPostId),
        eq(dripPosts.postId, post.id),
        eq(dripPosts.status, 'scheduled'),
      ),
    )
    .returning({ id: dripPosts.id });
  if (!row) return false;

  if (published) {
    await db
      .update(dripCampaigns)
      .set({
        completedOccurrences: sql`${dripCampaigns.completedOccurrences} + 1`,
        consecutiveErrors: 0,
        updatedAt: now,
      })
      .where(eq(dripCampaigns.id, campaignId));
  }

  await db.insert(dripCampaignHistory).values({
    dripCampaignId: campaignId,
    dripPostId,
    action: 'published',
    previousStatus: 'scheduled',
    newStatus: published ? 'published' : 'failed',
    performedBySystem: true,
    details: { postId: post.id, publishStatus: post.status, resumed: true },
  });
  return true;
}
