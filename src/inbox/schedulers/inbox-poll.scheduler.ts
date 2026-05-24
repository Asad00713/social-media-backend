import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { QUEUES } from '../../queue/queue.module';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';

/**
 * Enqueues inbox polling jobs every 5 minutes.
 *
 * Coverage strategy per platform (Phase 1 — all 6 supported platforms poll):
 *   - YouTube, Bluesky, Mastodon: no webhooks at all, poll is the only path.
 *   - Threads: Meta doesn't deliver webhooks in app development mode (only
 *     after App Review). Poll as a dev-mode fallback.
 *   - Instagram (Business Login path): IG webhooks via `graph.instagram.com`
 *     require the app in published state. Poll in dev.
 *   - Facebook: webhook DOES fire in dev for app-role accounts, but in
 *     practice delivery is flaky (Meta drops some events; per-Page
 *     `/subscribed_apps` can silently fall off). Poll as belt-and-suspenders
 *     so the inbox stays accurate within 5 min even when a webhook is missed.
 *
 * Duplicate prevention: the unique constraint on
 * `inbox_items.(channel_id, platform_item_id)` drops any second insert from
 * the webhook + poll race.
 *
 * Jobs are staggered 200ms apart to spread load across platform APIs.
 */
@Injectable()
export class InboxPollScheduler {
  private readonly logger = new Logger(InboxPollScheduler.name);

  private static readonly POLLED_PLATFORMS = [
    'youtube',
    'bluesky',
    'mastodon',
    'threads',
    'instagram',
    'facebook',
  ] as const;

  constructor(@InjectQueue(QUEUES.INBOX_POLLING) private readonly queue: Queue) {}

  @Cron('*/5 * * * *', { timeZone: 'UTC', name: 'enqueueInboxPolling' })
  async enqueueInboxPolling(): Promise<void> {
    const rows = await db
      .select({ id: socialMediaChannels.id })
      .from(socialMediaChannels)
      .where(
        and(
          inArray(
            socialMediaChannels.platform,
            InboxPollScheduler.POLLED_PLATFORMS as unknown as string[],
          ),
          eq(socialMediaChannels.connectionStatus, 'connected'),
          eq(socialMediaChannels.isActive, true),
        ),
      );

    if (rows.length === 0) {
      this.logger.verbose('Inbox polling: no eligible channels');
      return;
    }

    this.logger.log(`Inbox polling: enqueuing ${rows.length} jobs`);

    for (let i = 0; i < rows.length; i++) {
      await this.queue.add(
        'poll',
        { channelId: rows[i].id },
        { delay: i * 200, jobId: `inbox-poll-${rows[i].id}-${Date.now()}` },
      );
    }
  }
}
