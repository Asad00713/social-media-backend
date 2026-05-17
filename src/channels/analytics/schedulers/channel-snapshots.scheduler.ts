import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUES } from '../../../queue/queue.module';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { socialMediaChannels } from '../../../drizzle/schema/channels.schema';
import type { SupportedPlatform } from '../../../drizzle/schema/channels.schema';

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
        r.isActive && (SOCIAL_PLATFORMS as readonly string[]).includes(r.platform),
    );

    this.logger.log(`Enqueuing recent-posts-sync for ${eligible.length} active channels`);

    for (let i = 0; i < eligible.length; i++) {
      const r = eligible[i];
      await this.queue.add(
        'channel-recent-posts-sync',
        { channelId: r.id, workspaceId: r.workspaceId, sinceDays: 7, limit: 50 },
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
        r.isActive && (SOCIAL_PLATFORMS as readonly string[]).includes(r.platform),
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
}
