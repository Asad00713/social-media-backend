import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq, sql as sqlOp } from 'drizzle-orm';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { socialMediaChannels, type SupportedPlatform } from '../../../drizzle/schema/channels.schema';
import { posts as postsTable } from '../../../drizzle/schema/posts.schema';
import { channelSyncState } from '../../../drizzle/schema/channel-sync-state.schema';
import { QUEUES } from '../../../queue/queue.module';
import { AdapterRegistryService } from '../services/adapter-registry.service';
import { QuotaTrackerService } from '../services/quota-tracker.service';
import { decrypt } from '../../../common/utils/encryption.util';
import type { AgeBucket } from '../types/platform-capabilities.types';

export interface ChannelRecentPostsSyncJob {
  channelId: number;
  workspaceId: string;
  sinceDays?: number; // default 7; backfill passes 90
  limit?: number; // default 50
}

const BUCKET_TO_DELAY_MS: Partial<Record<AgeBucket, number>> = {
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

@Injectable()
export class ChannelRecentPostsSyncHandler {
  private readonly logger = new Logger(ChannelRecentPostsSyncHandler.name);

  constructor(
    private readonly registry: AdapterRegistryService,
    private readonly quota: QuotaTrackerService,
    @InjectQueue(QUEUES.CHANNEL_SNAPSHOTS) private readonly queue: Queue,
    @Inject(DRIZZLE) private readonly db: any,
  ) {}

  async handle(data: ChannelRecentPostsSyncJob): Promise<{ ok: boolean; synced?: number; created?: number }> {
    const { channelId, workspaceId } = data;
    const sinceDays = data.sinceDays ?? 7;
    const limit = data.limit ?? 50;

    const rows = await this.db
      .select()
      .from(socialMediaChannels)
      .where(eq(socialMediaChannels.id, channelId))
      .limit(1);
    const channel = rows[0];
    if (!channel) {
      this.logger.warn(`Recent posts sync: channel ${channelId} not found`);
      return { ok: false };
    }

    const platform = channel.platform as SupportedPlatform;
    if (!this.registry.has(platform)) {
      this.logger.log(`Recent posts sync: no adapter for ${platform}, skipping channel ${channelId}`);
      return { ok: true };
    }

    const adapter = this.registry.get(platform);
    if (!adapter.fetchRecentPosts) {
      this.logger.log(`Recent posts sync: adapter for ${platform} doesn't support fetchRecentPosts, skipping`);
      return { ok: true };
    }

    const cost = adapter.estimateQuotaCost('fetchRecentPosts');
    const quota = await this.quota.tryConsume(platform, cost);
    if (!quota.allowed) {
      this.logger.warn(`Recent posts sync: quota exhausted for ${platform}, deferring`);
      return { ok: false };
    }

    const channelForAdapter = { ...channel, accessToken: decrypt(channel.accessToken) };
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

    const result = await adapter.fetchRecentPosts(channelForAdapter, { since, limit });

    if (result.status === 'failed') {
      this.logger.error(`Recent posts sync failed for channel ${channelId}: ${result.error.message}`);
      return { ok: false };
    }

    const recentPosts = result.data.posts ?? [];
    let created = 0;

    for (const rp of recentPosts) {
      // Dedup: check if a post for this platformPostId already exists for this channel
      const existsResult: any = await this.db.execute(sqlOp`
        SELECT id FROM posts
        WHERE workspace_id = ${workspaceId}
          AND targets @> ${JSON.stringify([{ channelId: String(channelId), platformPostId: rp.platformPostId }])}::jsonb
        LIMIT 1
      `);
      const existsRow = (existsResult.rows ?? existsResult)[0];
      if (existsRow) continue;

      // Insert new post row
      const mediaItems = rp.mediaUrl
        ? [{ url: rp.mediaUrl, type: 'image' as const, thumbnailUrl: rp.mediaUrl }]
        : [];

      const target = {
        channelId: String(channelId),
        platform: channel.platform,
        status: 'published' as const,
        platformPostId: rp.platformPostId,
        publishedAt: rp.publishedAt.toISOString(),
      };

      const inserted = await this.db
        .insert(postsTable)
        .values({
          workspaceId,
          createdById: channel.connectedByUserId,
          content: rp.content,
          mediaItems,
          targets: [target],
          status: 'published',
          publishedAt: rp.publishedAt,
          metadata: { syncedFrom: 'platform', syncedAt: new Date().toISOString() },
        })
        .returning({ id: postsTable.id });

      created += 1;
      const newPostId = inserted[0].id as string;

      // Enqueue post-metric-snapshot trail starting at first bucket
      const pollingProfile = adapter.pollingProfile;
      const buckets = pollingProfile.schedulePerContentType[pollingProfile.defaultContentType] ?? [];
      if (buckets.length > 0) {
        const firstBucket = buckets[0];
        const delay = BUCKET_TO_DELAY_MS[firstBucket] ?? 60 * 60_000;
        await this.queue.add(
          'post-metric-snapshot',
          { postId: newPostId, channelId, ageBucket: firstBucket },
          { delay },
        );
      }
    }

    // Update lastPostsSyncAt
    await this.db
      .insert(channelSyncState)
      .values({
        channelId,
        nextProfileSyncAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        lastPostsSyncAt: new Date(),
      })
      .onConflictDoUpdate({
        target: channelSyncState.channelId,
        set: { lastPostsSyncAt: new Date() },
      });

    this.logger.log(
      `Recent posts sync: channel ${channelId} synced ${recentPosts.length} platform posts, ${created} new rows created`,
    );
    return { ok: true, synced: recentPosts.length, created };
  }
}
