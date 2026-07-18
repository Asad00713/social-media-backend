import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { YoutubeRetentionService } from '../services/youtube-retention.service';

/**
 * Runs the YouTube 30-day content retention wipe once a day.
 *
 * Daily rather than hourly because the obligation is measured in calendar days
 * and the work is a single indexed UPDATE. 03:00 UTC keeps it away from the
 * busiest publishing hours.
 *
 * NOTE for anyone reading this at deploy time: the first run in production will
 * wipe comment content older than 30 days. That is the intended, policy-required
 * behavior and it is not reversible. Analytics data is untouched.
 */
@Injectable()
export class YoutubeRetentionScheduler {
  private readonly logger = new Logger(YoutubeRetentionScheduler.name);

  constructor(private readonly retention: YoutubeRetentionService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM, {
    timeZone: 'UTC',
    name: 'youtubeContentRetention',
  })
  async wipeExpiredYoutubeContent(): Promise<void> {
    try {
      const { wiped } = await this.retention.wipeExpiredContent();
      this.logger.log(`YouTube retention sweep complete: ${wiped} items wiped`);
    } catch (err) {
      // Never rethrow from a cron handler — an unhandled rejection stops the
      // scheduler for every later tick, silently ending retention entirely.
      this.logger.error(
        `YouTube retention sweep failed: ${(err as Error).message}`,
      );
    }
  }
}
