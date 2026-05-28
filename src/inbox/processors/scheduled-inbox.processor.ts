import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUES } from '../../queue/queue.module';
import { ScheduledMessagesService } from '../services/scheduled-messages.service';
import { InboxService } from '../inbox.service';

export interface ScheduledInboxFireJob {
  scheduledId: string;
}

/**
 * Fires a scheduled inbox message at its scheduledAt time.
 *
 * Flow:
 *   1. Claim the row (transactional pending → sending). If 0 rows, abort —
 *      something else (cancel, race retry) already took it.
 *   2. Dispatch to InboxService.sendDm | reply | commentOnPost depending on
 *      type + whether parentItemId is set.
 *   3. On success: mark sent + link inbox row id.
 *   4. On error: throw — BullMQ retries (attempts=3, exponential backoff).
 *      Final retry: caller (this) marks failed and emits SSE.
 */
@Processor(QUEUES.SCHEDULED_INBOX)
export class ScheduledInboxProcessor
  extends WorkerHost
  implements OnModuleInit
{
  private readonly logger = new Logger(ScheduledInboxProcessor.name);

  constructor(
    private readonly scheduledService: ScheduledMessagesService,
    private readonly inboxService: InboxService,
  ) {
    super();
  }

  onModuleInit(): void {
    this.logger.log(
      `Scheduled-inbox worker registered on queue "${QUEUES.SCHEDULED_INBOX}" — ready to fire delayed jobs.`,
    );
  }

  async process(job: Job<ScheduledInboxFireJob>): Promise<{ ok: boolean }> {
    this.logger.log(
      `→ Processing job ${job.id} (name=${job.name}, attempt=${job.attemptsMade + 1}, delay-ms-overdue=${Date.now() - (job.timestamp + (job.opts.delay ?? 0))})`,
    );
    if (job.name !== 'fire') return { ok: true };
    const { scheduledId } = job.data;

    const claimed = await this.scheduledService.claimForFire(scheduledId);
    if (!claimed) {
      // Already sent / cancelled / failed — no-op.
      this.logger.warn(
        `Scheduled fire ${scheduledId}: no pending row to claim (already processed or missing in DB)`,
      );
      return { ok: true };
    }
    this.logger.log(
      `Claimed scheduled ${scheduledId} (type=${claimed.type}, channel=${claimed.channelId}, thread=${claimed.threadKey}) — dispatching now.`,
    );

    const isFinalAttempt =
      job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

    try {
      const userId = claimed.createdByUserId;
      if (!userId) {
        throw new Error('Scheduled message has no creator — cannot dispatch');
      }

      let inboxItemId: string | null = null;

      if (claimed.type === 'dm') {
        const result = await this.inboxService.sendDm(
          claimed.workspaceId,
          userId,
          claimed.threadKey,
          claimed.text,
        );
        inboxItemId = result.id;
      } else {
        // comment — nested reply vs top-level
        if (claimed.parentItemId) {
          const result = await this.inboxService.reply(
            claimed.workspaceId,
            userId,
            claimed.parentItemId,
            claimed.text,
          );
          inboxItemId = result.id;
        } else {
          const result = await this.inboxService.commentOnPost(
            claimed.workspaceId,
            userId,
            claimed.threadKey,
            claimed.text,
          );
          inboxItemId = result.id;
        }
      }

      await this.scheduledService.markSent(scheduledId, inboxItemId);
      this.logger.log(
        `Scheduled fire ${scheduledId}: ${claimed.type} sent → inbox item ${inboxItemId}`,
      );
      return { ok: true };
    } catch (err) {
      const message = (err as Error).message || 'Unknown error';
      this.logger.error(
        `Scheduled fire ${scheduledId} failed (attempt ${job.attemptsMade + 1}): ${message}`,
      );

      if (isFinalAttempt) {
        await this.scheduledService.markFailed(scheduledId, message);
      } else {
        // BullMQ will retry — flip back to pending so the next attempt can claim.
        await this.scheduledService.resetToPendingForRetry(scheduledId, message);
      }
      throw err;
    }
  }
}
