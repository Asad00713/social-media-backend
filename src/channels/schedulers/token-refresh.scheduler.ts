import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { QUEUES } from '../../queue/queue.module';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';

/**
 * Proactively refreshes access tokens for channels whose tokens will expire
 * within the next 30 minutes. Runs every 10 minutes. Channels without a
 * refresh token (e.g., platforms that only issue access tokens) are skipped —
 * those need user reconnect when they expire.
 *
 * Conservative 30-minute window lets refresh-token-rotation platforms breathe
 * without thrashing. Jobs are staggered 100ms apart to avoid thundering herds
 * against platform rate limits.
 */
@Injectable()
export class TokenRefreshScheduler {
  private readonly logger = new Logger(TokenRefreshScheduler.name);

  constructor(
    @InjectQueue(QUEUES.TOKEN_REFRESH) private readonly queue: Queue,
    @Inject(DRIZZLE) private readonly db: any,
  ) {}

  @Cron('*/10 * * * *', { timeZone: 'UTC', name: 'enqueueTokenRefreshes' })
  async enqueueTokenRefreshes(): Promise<void> {
    const horizon = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes from now

    const rows = await this.db
      .select({ id: socialMediaChannels.id })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.connectionStatus, 'connected'),
          eq(socialMediaChannels.isActive, true),
          isNotNull(socialMediaChannels.refreshToken),
          isNotNull(socialMediaChannels.tokenExpiresAt),
          lte(socialMediaChannels.tokenExpiresAt, horizon),
        ),
      );

    if (rows.length === 0) {
      this.logger.verbose('Token refresh: no eligible channels');
      return;
    }

    this.logger.log(
      `Token refresh: enqueuing ${rows.length} refresh jobs (token expiring within 30 min)`,
    );

    for (let i = 0; i < rows.length; i++) {
      await this.queue.add(
        'token-refresh',
        { channelId: rows[i].id },
        { delay: i * 100 }, // stagger 100ms apart to spread platform-API load
      );
    }
  }
}
