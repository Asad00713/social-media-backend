import { Injectable, Inject, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
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
import { AnalyticsEventEmitter } from '../../../realtime/analytics-event-emitter.service';

export interface ChannelProfileSnapshotJob {
  channelId: number;
  workspaceId: string;
}

@Injectable()
export class ChannelProfileSnapshotHandler {
  private readonly logger = new Logger(ChannelProfileSnapshotHandler.name);

  constructor(
    private readonly registry: AdapterRegistryService,
    private readonly quota: QuotaTrackerService,
    private readonly events: AnalyticsEventEmitter,
    @Inject(DRIZZLE) private readonly db: any,
  ) {}

  async handle(data: ChannelProfileSnapshotJob): Promise<{ ok: boolean }> {
    const { channelId } = data;

    const rows = await this.db
      .select()
      .from(socialMediaChannels)
      .where(eq(socialMediaChannels.id, channelId))
      .limit(1);
    const channel = rows[0];
    if (!channel) {
      this.logger.warn(
        `Profile snapshot: channel ${channelId} not found, skipping`,
      );
      return { ok: false };
    }

    const platform = channel.platform as SupportedPlatform;
    if (!this.registry.has(platform)) {
      this.logger.log(
        `No adapter for platform ${platform}, skipping channel ${channelId}`,
      );
      return { ok: true };
    }

    const adapter = this.registry.get(platform);
    const cost = adapter.estimateQuotaCost('fetchProfileSnapshot');
    const quota = await this.quota.tryConsume(platform, cost);
    if (!quota.allowed) {
      this.logger.warn(
        `Quota exhausted for ${platform}, deferring channel ${channelId}`,
      );
      return { ok: false };
    }

    const channelForAdapter = {
      ...channel,
      accessToken: decrypt(channel.accessToken),
    };
    const result = await adapter.fetchProfileSnapshot(channelForAdapter);
    const today = new Date().toISOString().slice(0, 10);

    if (result.status === 'success' || result.status === 'partial') {
      const snapshotData = result.data;
      await this.db
        .insert(channelSnapshots)
        .values({
          channelId,
          snapshotDate: today,
          followersCount: snapshotData.followersCount ?? null,
          followingCount: snapshotData.followingCount ?? null,
          totalPostsCount: snapshotData.totalPostsCount ?? null,
          platformMetrics: snapshotData.platformMetrics ?? {},
          metricsSchemaVersion: 1,
          fetchedAt: new Date(),
          syncStatus: result.status,
          syncError: null,
        })
        .onConflictDoNothing({
          target: [channelSnapshots.channelId, channelSnapshots.snapshotDate],
        });

      // Update channels.metadata + lastSyncedAt so the UI header chips reflect fresh data.
      // The daily snapshot writes to channel_snapshots but the header reads from channels.metadata
      // which was frozen at OAuth-connect-time (often all zeros). We spread existing metadata
      // first to preserve any platform-specific fields written by the original connect flow,
      // then override with the fresh counts. Both common aliases are written so the frontend
      // normalizer finds the right key regardless of platform.
      const platformMetricsData = snapshotData.platformMetrics ?? {};
      await this.db
        .update(socialMediaChannels)
        .set({
          metadata: {
            ...(channel.metadata ?? {}),
            subscriberCount: snapshotData.followersCount ?? null,
            followersCount: snapshotData.followersCount ?? null,
            videoCount: snapshotData.totalPostsCount ?? null,
            totalPostsCount: snapshotData.totalPostsCount ?? null,
            viewCount:
              (platformMetricsData as any).viewCount ??
              channel.metadata?.viewCount ??
              null,
            description:
              (platformMetricsData as any).description ??
              channel.metadata?.description ??
              null,
            thumbnailUrl:
              (platformMetricsData as any).thumbnailUrl ??
              channel.metadata?.thumbnailUrl ??
              null,
          },
          lastSyncedAt: new Date(),
        })
        .where(eq(socialMediaChannels.id, channelId));

      await this.db
        .insert(channelSyncState)
        .values({
          channelId,
          lastProfileSyncAt: new Date(),
          lastProfileSyncStatus: 'success',
          lastProfileSyncError: null,
          nextProfileSyncAt: nextDayAt2UTC(),
          consecutiveFailures: 0,
        })
        .onConflictDoUpdate({
          target: channelSyncState.channelId,
          set: {
            lastProfileSyncAt: new Date(),
            lastProfileSyncStatus: 'success',
            lastProfileSyncError: null,
            nextProfileSyncAt: nextDayAt2UTC(),
            consecutiveFailures: 0,
          },
        });
      this.events.emit(channel.workspaceId, 'channel.snapshot.updated', {
        workspaceId: channel.workspaceId,
        channelId,
        platform: channel.platform,
        snapshotDate: today,
        followersCount: snapshotData.followersCount ?? null,
        totalPostsCount: snapshotData.totalPostsCount ?? null,
        platformMetrics: snapshotData.platformMetrics ?? {},
        fetchedAt: new Date().toISOString(),
      });
      this.events.emit(channel.workspaceId, 'channel.sync.state.changed', {
        workspaceId: channel.workspaceId,
        channelId,
        status: 'healthy',
        lastSyncedAt: new Date().toISOString(),
        consecutiveFailures: 0,
      });
      this.logger.log(
        `Profile snapshot success: channelId=${channelId} followers=${snapshotData.followersCount ?? '?'}`,
      );
      return { ok: true };
    }

    // failed — read current consecutiveFailures so we can increment, then
    // only escalate to "Reconnect Required" once auth_failed has happened
    // 3+ times in a row. One-off classifier mistakes (e.g., an analytics
    // adapter pointing at the wrong Graph endpoint returning code 190)
    // shouldn't break the channel UI.
    const RECONNECT_THRESHOLD = 3;
    const existing = await this.db
      .select({ consecutiveFailures: channelSyncState.consecutiveFailures })
      .from(channelSyncState)
      .where(eq(channelSyncState.channelId, channelId))
      .limit(1);
    const nextConsecutive = (existing[0]?.consecutiveFailures ?? 0) + 1;

    await this.db
      .insert(channelSyncState)
      .values({
        channelId,
        lastProfileSyncAt: new Date(),
        lastProfileSyncStatus:
          result.error.code === 'rate_limited' ? 'rate_limited' : 'failed',
        lastProfileSyncError: result.error.message,
        nextProfileSyncAt: nextDayAt2UTC(),
        consecutiveFailures: nextConsecutive,
      })
      .onConflictDoUpdate({
        target: channelSyncState.channelId,
        set: {
          lastProfileSyncAt: new Date(),
          lastProfileSyncStatus:
            result.error.code === 'rate_limited' ? 'rate_limited' : 'failed',
          lastProfileSyncError: result.error.message,
          consecutiveFailures: nextConsecutive,
        },
      });

    if (
      result.error.code === 'auth_failed' &&
      nextConsecutive >= RECONNECT_THRESHOLD
    ) {
      await this.db
        .update(socialMediaChannels)
        .set({
          connectionStatus: 'expired',
          lastError: result.error.message?.slice(0, 500) ?? null,
        })
        .where(eq(socialMediaChannels.id, channelId));
      this.logger.warn(
        `Channel ${channelId} marked 'expired' after ${nextConsecutive} consecutive auth failures`,
      );
    }

    this.logger.error(
      `Profile snapshot failed: channelId=${channelId} ${result.error.message}`,
    );
    return { ok: false };
  }
}

function nextDayAt2UTC(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(2, 0, 0, 0);
  return d;
}
