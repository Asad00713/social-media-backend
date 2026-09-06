import { Injectable, ForbiddenException, Logger } from '@nestjs/common';
import { eq, and, sql, count } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { posts } from '../../drizzle/schema';
import { SubscriptionLookupService } from './subscription-lookup.service';
import { canQueuePost, UNLIMITED } from './limit-resolver.util';

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
      .where(
        and(
          eq(posts.workspaceId, workspaceId),
          eq(posts.status, 'scheduled'),
          sql`${posts.targets} @> ${buildQueuedTargetJson(channelId)}::jsonb`,
        ),
      );

    return Number(row?.n ?? 0);
  }

  /**
   * Refuse the schedule if any target channel is already at its queue ceiling.
   *
   * Checked per channel, not per post: a post targeting three channels
   * occupies one slot on each.
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

    for (const channelId of channelIds) {
      const queued = await this.countQueuedForChannel(workspaceId, channelId);
      if (!canQueuePost(plan.queuedPostsPerChannel, queued)) {
        throw new ForbiddenException(
          `Scheduling queue full. This channel has ${queued} of ${plan.queuedPostsPerChannel} scheduled posts. ` +
            'Publish or remove a scheduled post, or upgrade for unlimited scheduling.',
        );
      }
    }
  }
}
