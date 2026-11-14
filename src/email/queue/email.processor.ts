import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { isFinalAttempt } from '../../queue/is-final-attempt';
import { QUEUES } from '../../queue/queue.module';
import { EMAIL_JOB_SEND, type EmailJobData } from './email-job';
import { EmailOutboxService } from './email-outbox.service';

/**
 * Consumes the `email` queue at 8 sends a second (spec §9). BullMQ keeps the
 * limiter's counter in Redis, per queue, so every worker on every replica
 * shares the one 8/s budget. Job names: `send` now; Task 11 adds
 * `post-failed-flush`.
 */
@Processor(QUEUES.EMAIL, {
  concurrency: 4,
  limiter: { max: 8, duration: 1000 },
})
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name);

  constructor(private readonly outbox: EmailOutboxService) {
    super();
  }

  async process(job: Job<EmailJobData>): Promise<string> {
    switch (job.name) {
      case EMAIL_JOB_SEND:
        return this.outbox.process(job.data, job.attemptsMade);
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
