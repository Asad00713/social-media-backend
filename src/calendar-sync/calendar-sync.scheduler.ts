import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../drizzle/db';
import { socialMediaChannels } from '../drizzle/schema/channels.schema';
import {
  CALENDAR_RECONCILE_CRON,
  CALENDAR_RECONCILE_JOB,
  CALENDAR_RECONCILE_QUEUE,
  CALENDAR_RENEWAL_CRON,
  CALENDAR_RENEWAL_JOB,
  CALENDAR_RENEWAL_QUEUE,
  DEFAULT_RECONCILE_INTERVAL_MS,
} from './calendar-sync.constants';

/**
 * CalendarSyncScheduler — the safety net behind the provider webhooks.
 *
 * Mirrors `InboxPollScheduler`: a @Cron picks every eligible channel and fans
 * out one BullMQ job per channel, staggered so we don't stampede the provider
 * APIs.
 *
 *  - **Reconcile poll (15 min).** Makes two-way sync work even when webhooks
 *    are unavailable (no public HTTPS host in dev, Google push channel expired,
 *    a Graph notification was dropped). This — not the webhook — is what
 *    guarantees the calendar converges.
 *  - **Renewal sweep (hourly).** Google watches and Graph subscriptions expire
 *    (7d / ~2.9d); this re-arms anything inside its safety window.
 *
 * Both use a deterministic, time-bucketed jobId so that a second backend
 * instance (or an overlapping tick) enqueuing the same work is dropped by
 * BullMQ instead of double-pulling a connection.
 */
@Injectable()
export class CalendarSyncScheduler {
  private readonly logger = new Logger(CalendarSyncScheduler.name);

  private static readonly CALENDAR_PLATFORMS = [
    'google_calendar',
    'outlook_calendar',
  ] as const;

  constructor(
    @InjectQueue(CALENDAR_RECONCILE_QUEUE)
    private readonly reconcileQueue: Queue,
    @InjectQueue(CALENDAR_RENEWAL_QUEUE) private readonly renewalQueue: Queue,
  ) {}

  @Cron(CALENDAR_RECONCILE_CRON, {
    timeZone: 'UTC',
    name: 'enqueueCalendarReconcile',
  })
  async enqueueCalendarReconcile(): Promise<void> {
    const rows = await db
      .select({ id: socialMediaChannels.id })
      .from(socialMediaChannels)
      .where(
        and(
          inArray(socialMediaChannels.platform, [
            ...CalendarSyncScheduler.CALENDAR_PLATFORMS,
          ]),
          eq(socialMediaChannels.connectionStatus, 'connected'),
          eq(socialMediaChannels.isActive, true),
        ),
      );

    if (rows.length === 0) {
      this.logger.verbose('Calendar reconcile: no eligible calendar channels');
      return;
    }

    // One bucket per poll interval → the same tick enqueued twice is deduped.
    const bucket = Math.floor(Date.now() / DEFAULT_RECONCILE_INTERVAL_MS);

    this.logger.log(`Calendar reconcile: enqueuing ${rows.length} jobs`);

    for (let i = 0; i < rows.length; i++) {
      await this.reconcileQueue.add(
        CALENDAR_RECONCILE_JOB,
        { channelId: rows[i].id },
        {
          delay: i * 200, // stagger — spread provider-API load
          jobId: `calendar-reconcile-${rows[i].id}-${bucket}`,
        },
      );
    }
  }

  @Cron(CALENDAR_RENEWAL_CRON, {
    timeZone: 'UTC',
    name: 'enqueueCalendarRenewal',
  })
  async enqueueCalendarRenewal(): Promise<void> {
    const hourBucket = Math.floor(Date.now() / (60 * 60 * 1000));

    await this.renewalQueue.add(
      CALENDAR_RENEWAL_JOB,
      {},
      { jobId: `calendar-renewal-${hourBucket}` },
    );

    this.logger.verbose('Calendar renewal sweep enqueued');
  }
}
