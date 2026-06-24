import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { QUEUES } from '../../../queue/queue.module';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { socialMediaChannels } from '../../../drizzle/schema/channels.schema';
import type { SupportedPlatform } from '../../../drizzle/schema/channels.schema';
import { channelSyncState } from '../../../drizzle/schema/channel-sync-state.schema';
import { YouTubePubSubHubbubService } from '../services/youtube-pubsubhubbub.service';

const SOCIAL_PLATFORMS: readonly SupportedPlatform[] = [
  'facebook',
  'instagram',
  'youtube',
  'tiktok',
  'pinterest',
  'twitter',
  'linkedin',
  'threads',
  'bluesky',
  'mastodon',
];

/**
 * Daily cron jobs for recent-posts discovery and metric rollups.
 *
 * NOTE: The `enqueueProfileSnapshots` method (previously on 02:00 UTC daily)
 * has been removed. Channel profile snapshots are now driven by
 * TieredPollingScheduler which runs every 5 min and applies age-based
 * intervals (new channel: 5 min, active: 15 min, otherwise: 30 min).
 *
 * Remaining methods:
 *   - enqueueRecentPostsSync (02:30 daily) — discovers externally-uploaded posts
 *   - enqueueDailyRollups   (03:00 daily) — daily by nature, kept as-is
 *
 * Cloud-storage channels (google_drive etc.) are excluded — analytics only
 * applies to social platforms.
 */
@Injectable()
export class ChannelSnapshotsScheduler {
  private readonly logger = new Logger(ChannelSnapshotsScheduler.name);

  constructor(
    @InjectQueue(QUEUES.CHANNEL_SNAPSHOTS) private readonly queue: Queue,
    @Inject(DRIZZLE) private readonly db: any,
    private readonly pubsub: YouTubePubSubHubbubService,
  ) {}

  @Cron('30 2 * * *', { timeZone: 'UTC', name: 'enqueueRecentPostsSync' })
  async enqueueRecentPostsSync(): Promise<void> {
    const rows = await this.db
      .select({
        id: socialMediaChannels.id,
        workspaceId: socialMediaChannels.workspaceId,
        platform: socialMediaChannels.platform,
        isActive: socialMediaChannels.isActive,
      })
      .from(socialMediaChannels);

    const eligible = rows.filter(
      (r: { isActive: boolean; platform: string }) =>
        r.isActive &&
        (SOCIAL_PLATFORMS as readonly string[]).includes(r.platform),
    );

    this.logger.log(
      `Enqueuing recent-posts-sync for ${eligible.length} active channels`,
    );

    for (let i = 0; i < eligible.length; i++) {
      const r = eligible[i];
      await this.queue.add(
        'channel-recent-posts-sync',
        {
          channelId: r.id,
          workspaceId: r.workspaceId,
          sinceDays: 7,
          limit: 50,
        },
        { delay: i * 100 },
      );
    }
  }

  @Cron('0 3 * * *', { timeZone: 'UTC', name: 'enqueueDailyRollups' })
  async enqueueDailyRollups(): Promise<void> {
    const rows = await this.db
      .select({
        id: socialMediaChannels.id,
        platform: socialMediaChannels.platform,
        isActive: socialMediaChannels.isActive,
      })
      .from(socialMediaChannels);

    const eligible = rows.filter(
      (r: { isActive: boolean; platform: string }) =>
        r.isActive &&
        (SOCIAL_PLATFORMS as readonly string[]).includes(r.platform),
    );

    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const date = yesterday.toISOString().slice(0, 10);

    this.logger.log(
      `Enqueuing daily rollups for ${eligible.length} channels for ${date}`,
    );

    for (let i = 0; i < eligible.length; i++) {
      await this.queue.add(
        'channel-daily-rollup',
        { channelId: eligible[i].id, date },
        { delay: i * 100 },
      );
    }
  }

  /**
   * Daily cron at 04:00 UTC.
   * Re-subscribes YouTube channels whose PubSubHubbub lease expires within the
   * next 2 days (or has never been confirmed). Subscriptions are valid for 10
   * days — renewing at the 8-day mark gives a 2-day safety window.
   */
  @Cron('0 4 * * *', { timeZone: 'UTC', name: 'renewYouTubePubSubHubbub' })
  async renewYouTubePubSubHubbub(): Promise<void> {
    const inTwoDays = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

    const rows = await this.db
      .select({
        id: socialMediaChannels.id,
        platformAccountId: socialMediaChannels.platformAccountId,
      })
      .from(socialMediaChannels)
      .leftJoin(
        channelSyncState,
        eq(channelSyncState.channelId, socialMediaChannels.id),
      )
      .where(
        and(
          eq(socialMediaChannels.platform, 'youtube'),
          eq(socialMediaChannels.isActive, true),
          eq(socialMediaChannels.connectionStatus, 'connected'),
          or(
            isNull(channelSyncState.pubsubhubbubLeaseExpiresAt),
            lt(channelSyncState.pubsubhubbubLeaseExpiresAt, inTwoDays),
          ),
        ),
      );

    const list = rows as Array<{ id: number; platformAccountId: string }>;
    this.logger.log(
      `renewYouTubePubSubHubbub: renewing ${list.length} YT channel(s)`,
    );

    for (const r of list) {
      await this.pubsub.subscribe(Number(r.id), r.platformAccountId);
    }
  }
}
