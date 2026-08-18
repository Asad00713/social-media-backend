import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUES } from '../../queue/queue.module';
import { EvergreenService } from '../evergreen.service';

interface EvergreenFireJobData {
  occurrenceId: string;
}

/**
 * Consumes the `evergreen-rotation` queue. Each job fires exactly one
 * `evergreenOccurrences` row: `EvergreenService.fireOccurrence` publishes the
 * picked post and — in its own `finally` — arms the category's next fire, so
 * the chain is self-perpetuating from here on. Mirrors
 * `src/posts/processors/post-publish.processor.ts`'s shape.
 */
@Processor(QUEUES.EVERGREEN_ROTATION, {
  concurrency: 5,
})
export class EvergreenFireProcessor extends WorkerHost {
  private readonly logger = new Logger(EvergreenFireProcessor.name);

  constructor(private readonly evergreen: EvergreenService) {
    super();
  }

  async process(job: Job<EvergreenFireJobData>): Promise<void> {
    const { occurrenceId } = job.data;
    this.logger.log(`Firing evergreen occurrence: ${occurrenceId}`);
    await this.evergreen.fireOccurrence(occurrenceId);
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<EvergreenFireJobData>) {
    this.logger.log(
      `Job ${job.id} completed for occurrence ${job.data.occurrenceId}`,
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<EvergreenFireJobData> | undefined, error: Error) {
    if (job) {
      this.logger.error(
        `Job ${job.id} failed for occurrence ${job.data.occurrenceId} after ${job.attemptsMade} attempts: ${error.message}`,
      );
    }
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string) {
    this.logger.warn(`Job ${jobId} stalled`);
  }
}
