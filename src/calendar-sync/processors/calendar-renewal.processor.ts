import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  CALENDAR_RENEWAL_JOB,
  CALENDAR_RENEWAL_QUEUE,
} from '../calendar-sync.constants';
import { CalendarSubscriptionService } from '../services/calendar-subscription.service';

export type CalendarRenewalJob = Record<string, never>;

/**
 * Hourly sweep that re-arms every provider push subscription approaching expiry
 * (Google watch < 24h left → stop + re-watch; Graph subscription < 12h left →
 * PATCH, falling back to a re-create). Enqueued by CalendarSyncScheduler.
 *
 * `renewDueSoon()` isolates failures per connection, so the sweep as a whole
 * only fails on infrastructure errors — those get the queue's default
 * 3-attempt exponential backoff.
 */
@Processor(CALENDAR_RENEWAL_QUEUE, {
  lockDuration: 5 * 60 * 1000,
  lockRenewTime: 30 * 1000,
})
export class CalendarRenewalProcessor extends WorkerHost {
  private readonly logger = new Logger(CalendarRenewalProcessor.name);

  constructor(
    private readonly subscriptionService: CalendarSubscriptionService,
  ) {
    super();
  }

  async process(job: Job<CalendarRenewalJob>): Promise<{ ok: boolean }> {
    if (job.name !== CALENDAR_RENEWAL_JOB) return { ok: true };

    this.logger.verbose('Calendar renewal sweep: starting');
    await this.subscriptionService.renewDueSoon();
    return { ok: true };
  }
}
