import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { QUEUES } from '../../../queue/queue.module';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { socialMediaChannels, type SupportedPlatform } from '../../../drizzle/schema/channels.schema';
import { channelSnapshots } from '../../../drizzle/schema/channel-snapshots.schema';
import { channelSyncState } from '../../../drizzle/schema/channel-sync-state.schema';
import { AdapterRegistryService } from '../services/adapter-registry.service';
import { QuotaTrackerService } from '../services/quota-tracker.service';
import { decrypt } from '../../../common/utils/encryption.util';

export interface ChannelInitialBackfillJob {
  channelId: number;
  workspaceId: string;
}

const BACKFILL_DAYS = 30;

@Processor(QUEUES.CHANNEL_SNAPSHOTS)
export class ChannelInitialBackfillProcessor extends WorkerHost {
  private readonly logger = new Logger(ChannelInitialBackfillProcessor.name);

  constructor(
    private readonly registry: AdapterRegistryService,
    private readonly quota: QuotaTrackerService,
    @Inject(DRIZZLE) private readonly db: any,
  ) {
    super();
  }

  async process(job: Job<ChannelInitialBackfillJob>): Promise<{ ok: boolean }> {
    if (job.name !== 'channel-initial-backfill') return { ok: true };
    const { channelId } = job.data;

    const rows = await this.db.select().from(socialMediaChannels).where(eq(socialMediaChannels.id, channelId)).limit(1);
    const channel = rows[0];
    if (!channel || !this.registry.has(channel.platform as SupportedPlatform)) {
      this.logger.log(`Backfill: no adapter for ${channel?.platform ?? 'unknown'}, skipping channelId=${channelId}`);
      await this.markBackfillStatus(channelId, 'completed');
      return { ok: true };
    }

    await this.markBackfillStatus(channelId, 'running');

    const adapter = this.registry.get(channel.platform as SupportedPlatform);
    const channelForAdapter = { ...channel, accessToken: decrypt(channel.accessToken) };

    // 1. Profile snapshot
    const profileCost = adapter.estimateQuotaCost('fetchProfileSnapshot');
    const pq = await this.quota.tryConsume(channel.platform as SupportedPlatform, profileCost);
    if (pq.allowed) {
      const profile = await adapter.fetchProfileSnapshot(channelForAdapter);
      if (profile.status !== 'failed') {
        await this.db
          .insert(channelSnapshots)
          .values({
            channelId,
            snapshotDate: new Date().toISOString().slice(0, 10),
            followersCount: profile.data.followersCount ?? null,
            followingCount: profile.data.followingCount ?? null,
            totalPostsCount: profile.data.totalPostsCount ?? null,
            platformMetrics: profile.data.platformMetrics ?? {},
            metricsSchemaVersion: 1,
            fetchedAt: new Date(),
            syncStatus: profile.status,
            syncError: null,
          })
          .onConflictDoNothing();
      }
    }

    // 2. Recent posts (if adapter supports it). Phase 2 just logs the count —
    // creating synthetic post rows is out of scope (needs post-sync flow design).
    if (adapter.fetchRecentPosts) {
      const since = new Date(Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000);
      const recentCost = adapter.estimateQuotaCost('fetchRecentPosts');
      const rq = await this.quota.tryConsume(channel.platform as SupportedPlatform, recentCost);
      if (rq.allowed) {
        const recent = await adapter.fetchRecentPosts(channelForAdapter, { since, limit: 50 });
        if (recent.status !== 'failed') {
          const count = recent.data.posts?.length ?? 0;
          this.logger.log(
            `Backfill: ${count} recent posts available (not persisted in Phase 2; needs post-sync flow)`,
          );
        }
      }
    }

    await this.markBackfillStatus(channelId, 'completed');
    this.logger.log(`Initial backfill completed for channelId=${channelId}`);
    return { ok: true };
  }

  private async markBackfillStatus(
    channelId: number,
    status: 'pending' | 'running' | 'completed' | 'failed',
  ): Promise<void> {
    await this.db
      .insert(channelSyncState)
      .values({
        channelId,
        nextProfileSyncAt: new Date(Date.now() + 60 * 60 * 1000),
        consecutiveFailures: 0,
        initialBackfillStatus: status,
        initialBackfillCompletedAt: status === 'completed' ? new Date() : null,
      })
      .onConflictDoUpdate({
        target: channelSyncState.channelId,
        set: {
          initialBackfillStatus: status,
          initialBackfillCompletedAt: status === 'completed' ? new Date() : null,
        },
      });
  }
}
