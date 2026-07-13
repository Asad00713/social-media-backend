import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  CALENDAR_RECONCILE_JOB,
  CALENDAR_RECONCILE_QUEUE,
} from '../calendar-sync.constants';
import { CalendarPullSyncService } from '../services/calendar-pull-sync.service';

export interface CalendarReconcileJob {
  channelId: number;
}

/**
 * Runs one calendar connection's delta pull (external-event import + two-way
 * write-back). Enqueued by:
 *   - CalendarWebhookController — a provider said "something changed"
 *   - CalendarSyncScheduler     — the 15-min safety-net poll
 *   - ChannelsController        — right after a calendar is connected
 *
 * `reconcile()` is idempotent and never throws (per-connection failures are
 * logged inside the service), so the queue's default 3-attempt exponential
 * backoff only ever kicks in for infrastructure-level failures.
 *
 * A delta pull walks provider pages and can write back to many posts, so — like
 * InboxPollProcessor — the BullMQ lock is widened well past the default 30s and
 * renewed while the job runs.
 */
@Processor(CALENDAR_RECONCILE_QUEUE, {
  lockDuration: 5 * 60 * 1000,
  lockRenewTime: 30 * 1000,
})
export class CalendarReconcileProcessor extends WorkerHost {
  private readonly logger = new Logger(CalendarReconcileProcessor.name);

  constructor(private readonly pullSync: CalendarPullSyncService) {
    super();
  }

  async process(job: Job<CalendarReconcileJob>): Promise<{ ok: boolean }> {
    if (job.name !== CALENDAR_RECONCILE_JOB) return { ok: true };

    const { channelId } = job.data;
    if (typeof channelId !== 'number') {
      this.logger.warn(
        `Calendar reconcile: job ${job.id} has no numeric channelId — skipping`,
      );
      return { ok: false };
    }

    await this.pullSync.reconcile(channelId);
    return { ok: true };
  }
}
