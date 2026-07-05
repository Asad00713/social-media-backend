import { Injectable, Inject, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import {
  socialMediaChannels,
  type SupportedPlatform,
} from '../../../drizzle/schema/channels.schema';
import { channelSnapshots } from '../../../drizzle/schema/channel-snapshots.schema';
import { channelSyncState } from '../../../drizzle/schema/channel-sync-state.schema';
import { AdapterRegistryService } from '../services/adapter-registry.service';
import { QuotaTrackerService } from '../services/quota-tracker.service';
import { decrypt } from '../../../common/utils/encryption.util';
import { ChannelRecentPostsSyncHandler } from './channel-recent-posts-sync.handler';

export interface ChannelInitialBackfillJob {
  channelId: number;
  workspaceId: string;
}

@Injectable()
export class ChannelInitialBackfillHandler {
  private readonly logger = new Logger(ChannelInitialBackfillHandler.name);

  constructor(
    private readonly registry: AdapterRegistryService,
    private readonly quota: QuotaTrackerService,
    private readonly recentPostsSync: ChannelRecentPostsSyncHandler,
    @Inject(DRIZZLE) private readonly db: any,
  ) {}

  async handle(data: ChannelInitialBackfillJob): Promise<{ ok: boolean }> {
    const { channelId } = data;

    const rows = await this.db
      .select()
      .from(socialMediaChannels)
      .where(eq(socialMediaChannels.id, channelId))
      .limit(1);
    const channel = rows[0];
    if (!channel || !this.registry.has(channel.platform as SupportedPlatform)) {
      this.logger.log(
        `Backfill: no adapter for ${channel?.platform ?? 'unknown'}, skipping channelId=${channelId}`,
      );
      await this.markBackfillStatus(channelId, 'completed');
      return { ok: true };
    }

    await this.markBackfillStatus(channelId, 'running');

    const adapter = this.registry.get(channel.platform as SupportedPlatform);
    const channelForAdapter = {
      ...channel,
      accessToken: decrypt(channel.accessToken),
    };

    // 1. Profile snapshot — skip if connect already wrote today's snapshot
    //    synchronously (ChannelSyncLifecycleService.onChannelConnected runs the
    //    full ChannelProfileSnapshotHandler inline). That path also updates
    //    channels.metadata + emits realtime events, so re-fetching here would
    //    only burn quota. If the inline fetch failed, no row exists for today
    //    and we run the fetch here as the fallback.
    const today = new Date().toISOString().slice(0, 10);
    const existingToday = await this.db
      .select({ channelId: channelSnapshots.channelId })
      .from(channelSnapshots)
      .where(
        and(
          eq(channelSnapshots.channelId, channelId),
          eq(channelSnapshots.snapshotDate, today),
        ),
      )
      .limit(1);

    if (existingToday.length === 0) {
      const profileCost = adapter.estimateQuotaCost('fetchProfileSnapshot');
      const pq = await this.quota.tryConsume(
        channel.platform as SupportedPlatform,
        profileCost,
      );
      if (pq.allowed) {
        const profile = await adapter.fetchProfileSnapshot(channelForAdapter);
        if (profile.status !== 'failed') {
          await this.db
            .insert(channelSnapshots)
            .values({
              channelId,
              snapshotDate: today,
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
    } else {
      this.logger.log(
        `Backfill: today's snapshot already present for channelId=${channelId} (inline connect fetch) — skipping profile re-fetch`,
      );
    }

    // 2. Recent posts — delegate to ChannelRecentPostsSyncHandler for full persistence.
    const syncResult = await this.recentPostsSync.handle({
      channelId,
      workspaceId: data.workspaceId,
      sinceDays: 90,
      limit: 50,
      // Connect-time: fetch each post's first metrics immediately (no bucket
      // delay) so engagement appears within seconds and the overview
      // auto-refreshes via post.metrics.updated.
      immediate: true,
    });
    this.logger.log(
      `Initial backfill: recent-posts-sync returned ${JSON.stringify(syncResult)}`,
    );

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
          initialBackfillCompletedAt:
            status === 'completed' ? new Date() : null,
        },
      });
  }
}
