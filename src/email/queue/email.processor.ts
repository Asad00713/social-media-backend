import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
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
  constructor(private readonly outbox: EmailOutboxService) {
    super();
  }

  async process(job: Job<EmailJobData>): Promise<string> {
    switch (job.name) {
      case EMAIL_JOB_SEND:
        return this.outbox.process(job.data);
      default:
        throw new UnrecoverableError(`Unknown email job "${job.name}"`);
    }
  }
}
