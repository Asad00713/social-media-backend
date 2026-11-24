import { Injectable, Logger } from '@nestjs/common';
import { eq, and, sql, count } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { posts } from '../../drizzle/schema';
import { SubscriptionLookupService } from './subscription-lookup.service';
import { canQueuePost, UNLIMITED } from './limit-resolver.util';
import { queueLimitReached } from './queue-limit.error';
import { livePosts } from '../../posts/soft-delete/soft-delete';

/**
 * Build the jsonb containment probe for one channel.
 *
 * There is no post_targets table: a post's channels live in `posts.targets`, a
 * jsonb array of PostTarget objects. `@>` containment matches a row whose array
 * holds an object with these keys, so probing on channelId alone matches a
 * target regardless of its platform or per-target status.
 *
 * The id MUST be a string. post.service.ts writes String(channel.id) even
 * though social_media_channels.id is a bigint; a numeric probe matches nothing.
 */
export function buildQueuedTargetJson(channelId: string | number): string {
  return JSON.stringify([{ channelId: String(channelId) }]);
}

@Injectable()
export class PostQueueService {
  private readonly logger = new Logger(PostQueueService.name);

  constructor(private readonly lookup: SubscriptionLookupService) {}

  /**
   * Count posts still queued on a channel.
   *
   * Post-level status gates the row; the jsonb target carries the channel.
   * A partially-published post is deliberately NOT counted: its post-level
   * status has already left `scheduled`, so its remaining targets hold no
   * slot. Counting per-target status instead would hold a slot open on a post
   * the user considers sent.
   */
  async countQueuedForChannel(
    workspaceId: string,
    channelId: string,
  ): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(posts)
      .where(and(and(
          eq(posts.workspaceId, workspaceId),
          eq(posts.status, 'scheduled'),
          sql`${posts.targets} @> ${buildQueuedTargetJson(channelId)}::jsonb`,
        ), livePosts()));

    return Number(row?.n ?? 0);
  }

  /**
   * The same numbers `enforceQueueLimit` decides on, for a client that wants
   * to say so BEFORE the person writes the post.
   *
   * Read-only and deliberately shares `countQueuedForChannel` with the
   * enforcement path: two different counts would let the composer promise room
   * the scheduler then refuses. `limit` is `UNLIMITED` (-1) on a paid plan, and
   * callers must treat that as no cap rather than as a ceiling of -1.
   */
  async queueHeadroom(
    workspaceId: string,
    channelIds: string[],
  ): Promise<{ limit: number; queued: Record<string, number> }> {
    const subscription = await this.lookup.findByWorkspaceId(workspaceId);
    const plan = await this.lookup.getPlanLimits(
      subscription?.planCode ?? 'FREE',
    );
    const limit = plan.queuedPostsPerChannel;

    // No cap: the counts would be read and then ignored.
    if (limit === UNLIMITED || channelIds.length === 0) {
      return { limit, queued: {} };
    }

    const counts = await Promise.all(
      channelIds.map((channelId) =>
        this.countQueuedForChannel(workspaceId, channelId),
      ),
    );
    const queued: Record<string, number> = {};
    channelIds.forEach((channelId, i) => {
      queued[channelId] = counts[i];
    });
    return { limit, queued };
  }

  /**
   * Refuse the schedule if any target channel is already at its queue ceiling.
   *
   * Checked per channel, not per post: a post targeting three channels
   * occupies one slot on each. Counts run concurrently — a post targeting N
   * channels would otherwise pay N sequential round-trips on the scheduling
   * write path.
   *
   * When more than one channel is over its ceiling, the thrown message names
   * whichever comes first in `channelIds` (the caller's order), never
   * whichever count happens to settle first — `Promise.all` preserves input
   * order in its results, so the scan below is deterministic regardless of
   * completion order.
   */
  async enforceQueueLimit(
    workspaceId: string,
    channelIds: string[],
  ): Promise<void> {
    if (channelIds.length === 0) return;

    const subscription = await this.lookup.findByWorkspaceId(workspaceId);
    const planCode = subscription?.planCode ?? 'FREE';
    const plan = await this.lookup.getPlanLimits(planCode);

    // Cheapest possible exit for every paid tier.
    if (plan.queuedPostsPerChannel === UNLIMITED) return;

    const queuedCounts = await Promise.all(
      channelIds.map((channelId) =>
        this.countQueuedForChannel(workspaceId, channelId),
      ),
    );

    for (let i = 0; i < channelIds.length; i++) {
      const channelId = channelIds[i];
      const queued = queuedCounts[i];
      if (!canQueuePost(plan.queuedPostsPerChannel, queued)) {
        throw queueLimitReached(
          channelId,
          queued,
          plan.queuedPostsPerChannel,
        );
      }
    }
  }
}
