import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { isFinalAttempt } from '../../queue/is-final-attempt';
import { QUEUES } from '../../queue/queue.module';
import {
  POST_FAILED_FLUSH_JOB,
  PostFailureBatchService,
  type PostFailedFlushData,
} from '../batching/post-failure-batch.service';
import { EMAIL_JOB_SEND, type EmailJobData } from './email-job';
import { EmailOutboxService } from './email-outbox.service';

/**
 * Consumes the `email` queue at 5 sends a second. BullMQ keeps the limiter's
 * counter in Redis, per queue, so every worker on every replica shares the
 * one 5/s budget. Resend's default is 10/s per team, and sendNow (codes,
 * resets, invites, contact), reports and leads call it outside this limiter:
 * 5 leaves them headroom. Job names: `send`, and `post-failed-flush` (the
 * C1/C1a window closing).
 */
@Processor(QUEUES.EMAIL, {
  concurrency: 4,
  limiter: { max: 5, duration: 1000 },
})
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name);

  constructor(
    private readonly outbox: EmailOutboxService,
    private readonly postFailures: PostFailureBatchService,
  ) {
    super();
  }

  async process(
    job: Job<EmailJobData> | Job<PostFailedFlushData>,
  ): Promise<string> {
    switch (job.name) {
      case EMAIL_JOB_SEND:
        return this.outbox.process(job.data as EmailJobData, job.attemptsMade);
      case POST_FAILED_FLUSH_JOB: {
        const { userId, workspaceId, windowId } =
          job.data as PostFailedFlushData;
        return this.postFailures.flush(
          userId,
          workspaceId,
          windowId,
          job.attemptsMade,
        );
      }
      default:
        throw new UnrecoverableError(`Unknown email job "${job.name}"`);
    }
  }

  /**
   * One error line per email that will never be sent: an UnrecoverableError,
   * or the last attempt. Earlier retryable attempts stay console-only (error
   * lines persist to error_logs). Names the job and template, never the
   * address or the body.
   */
  @OnWorkerEvent('failed')
  onFailed(job: Job<EmailJobData> | undefined, error: Error): void {
    if (!job) return;
    const unrecoverable =
      error instanceof UnrecoverableError ||
      error.name === 'UnrecoverableError';
    if (!unrecoverable && !isFinalAttempt(job)) return;
    this.logger.error(
      `Email job ${job.id} (${job.name}, template ${job.data?.template ?? 'unknown'}) failed for good after ${job.attemptsMade} of ${job.opts.attempts ?? 1} attempts: ${error.message}`,
    );
  }
}
