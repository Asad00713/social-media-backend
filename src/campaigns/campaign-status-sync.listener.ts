import { Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../drizzle/db';
import {
  campaigns,
  campaignSlotContent,
  type CampaignSlotStatus,
} from '../drizzle/schema/campaigns.schema';
import type { posts } from '../drizzle/schema/posts.schema';

type PostRow = typeof posts.$inferSelect;

/** Loose shape of `posts.metadata` when it carries campaign-slot linkage.
 *  Written by `CampaignPublishingService.materializeAndEnqueue` (Task 3). */
interface CampaignPostMetadata {
  campaignId?: string;
  campaignSlot?: { date: string; channelId: string };
}

const TERMINAL_SLOT_STATUSES: readonly CampaignSlotStatus[] = ['published', 'failed'];
const OUTSTANDING_SLOT_STATUSES: readonly CampaignSlotStatus[] = ['scheduled', 'publishing'];

/**
 * Leaf provider (depends only on `db`) that syncs a campaign slot's status
 * from a post's publish outcome, and auto-completes the campaign once no
 * outstanding slots remain. Lives in `CampaignsModule`'s domain but is
 * *provided by `PostsModule`* and injected into `PostService` directly —
 * `CampaignsModule` already imports `PostsModule`, so a dependency the other
 * way (PostsModule -> CampaignsModule) would form a cycle. Because this
 * class only touches `db` (never `CampaignsService`/`PostService`), wiring
 * it into `PostsModule` doesn't pull `CampaignsModule` in and no cycle forms.
 */
@Injectable()
export class CampaignStatusSyncListener {
  private readonly logger = new Logger(CampaignStatusSyncListener.name);

  /**
   * Called from `PostService`'s publish finalizer right after the post row
   * is updated with its final status. No-op unless the post's `metadata`
   * carries `campaignId` + `campaignSlot` (i.e. it was materialized from a
   * campaign slot by `CampaignPublishingService`).
   */
  async syncFromPost(post: PostRow): Promise<void> {
    const meta = post.metadata as CampaignPostMetadata | undefined;
    if (!meta?.campaignId || !meta.campaignSlot) return;

    const slotStatus = this.mapPostStatusToSlotStatus(post.status);
    if (!slotStatus) return;

    const firstTarget = post.targets?.[0];

    await db
      .update(campaignSlotContent)
      .set({
        slotStatus,
        publishedAt: slotStatus === 'published' ? new Date() : undefined,
        lastError:
          slotStatus === 'failed'
            ? (firstTarget?.errorMessage ?? 'Publish failed')
            : undefined,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(campaignSlotContent.campaignId, meta.campaignId),
          eq(campaignSlotContent.date, meta.campaignSlot.date),
          eq(campaignSlotContent.channelId, meta.campaignSlot.channelId),
        ),
      );

    if (TERMINAL_SLOT_STATUSES.includes(slotStatus)) {
      await this.maybeCompleteCampaign(meta.campaignId);
    }
  }

  private mapPostStatusToSlotStatus(status: string): CampaignSlotStatus | null {
    if (status === 'published' || status === 'partially_published') return 'published';
    if (status === 'failed') return 'failed';
    if (status === 'publishing') return 'publishing';
    return null;
  }

  /**
   * Auto-completes the campaign once every slot has reached a terminal
   * state (no `scheduled`/`publishing` slots remain). Guarded by
   * `status:'active'` in the WHERE clause so a campaign the user has since
   * paused isn't silently flipped back to `completed`.
   */
  private async maybeCompleteCampaign(campaignId: string): Promise<void> {
    const outstanding = await db
      .select({ id: campaignSlotContent.id })
      .from(campaignSlotContent)
      .where(
        and(
          eq(campaignSlotContent.campaignId, campaignId),
          inArray(campaignSlotContent.slotStatus, OUTSTANDING_SLOT_STATUSES as CampaignSlotStatus[]),
        ),
      );

    if (outstanding.length > 0) return;

    await db
      .update(campaigns)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.status, 'active')));

    this.logger.log(`Campaign ${campaignId} auto-completed (no outstanding slots remain)`);
  }
}
