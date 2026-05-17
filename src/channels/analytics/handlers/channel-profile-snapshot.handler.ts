import { Injectable, Inject, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { socialMediaChannels, type SupportedPlatform } from '../../../drizzle/schema/channels.schema';
import { channelSnapshots } from '../../../drizzle/schema/channel-snapshots.schema';
import { channelSyncState } from '../../../drizzle/schema/channel-sync-state.schema';
import { AdapterRegistryService } from '../services/adapter-registry.service';
import { QuotaTrackerService } from '../services/quota-tracker.service';
import { decrypt } from '../../../common/utils/encryption.util';

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
      this.logger.warn(`Profile snapshot: channel ${channelId} not found, skipping`);
      return { ok: false };
    }

    const platform = channel.platform as SupportedPlatform;
    if (!this.registry.has(platform)) {
      this.logger.log(`No adapter for platform ${platform}, skipping channel ${channelId}`);
      return { ok: true };
    }

    const adapter = this.registry.get(platform);
    const cost = adapter.estimateQuotaCost('fetchProfileSnapshot');
    const quota = await this.quota.tryConsume(platform, cost);
    if (!quota.allowed) {
      this.logger.warn(`Quota exhausted for ${platform}, deferring channel ${channelId}`);
      return { ok: false };
    }

    const channelForAdapter = { ...channel, accessToken: decrypt(channel.accessToken) };
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
        .onConflictDoNothing({ target: [channelSnapshots.channelId, channelSnapshots.snapshotDate] });

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
      this.logger.log(`Profile snapshot success: channelId=${channelId} followers=${snapshotData.followersCount ?? '?'}`);
      return { ok: true };
    }

    // failed
    await this.db
      .insert(channelSyncState)
      .values({
        channelId,
        lastProfileSyncAt: new Date(),
        lastProfileSyncStatus: result.error.code === 'rate_limited' ? 'rate_limited' : 'failed',
        lastProfileSyncError: result.error.message,
        nextProfileSyncAt: nextDayAt2UTC(),
        consecutiveFailures: 1,
      })
      .onConflictDoUpdate({
        target: channelSyncState.channelId,
        set: {
          lastProfileSyncAt: new Date(),
          lastProfileSyncStatus: result.error.code === 'rate_limited' ? 'rate_limited' : 'failed',
          lastProfileSyncError: result.error.message,
        },
      });
    this.logger.error(`Profile snapshot failed: channelId=${channelId} ${result.error.message}`);
    return { ok: false };
  }
}

function nextDayAt2UTC(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(2, 0, 0, 0);
  return d;
}
