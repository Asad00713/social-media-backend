import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUES } from '../queue/queue.module';
import { FirstWeekRunService } from './first-week-run.service';
import type { FirstWeekJobData } from './first-week.types';

/** True once BullMQ has used every attempt (attemptsMade counts the one that just failed). */
export function isFinalAttempt(job: {
  attemptsMade: number;
  opts: { attempts?: number };
}): boolean {
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}

/**
 * Consumes the `first-week` queue. Its own queue (not the analytics
 * dispatcher) so a run that makes six LLM calls cannot starve snapshot jobs.
 */
@Processor(QUEUES.FIRST_WEEK, { concurrency: 2 })
export class FirstWeekProcessor extends WorkerHost {
  private readonly logger = new Logger(FirstWeekProcessor.name);

  constructor(private readonly run: FirstWeekRunService) {
    super();
  }

  async process(job: Job<FirstWeekJobData>): Promise<string> {
    return this.run.execute(job.data);
  }

  /** Only the LAST failed attempt flips the profile to `failed`; earlier ones are retried by BullMQ. */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<FirstWeekJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    this.logger.error(
      `First-week job ${job.id} failed (attempt ${job.attemptsMade}) for workspace ${job.data.workspaceId}: ${error.message}`,
    );
    if (!isFinalAttempt(job)) return;
    try {
      await this.run.markFailed(job.data.workspaceId, error.message);
    } catch (err) {
      this.logger.error(
        `Could not mark first week failed for ${job.data.workspaceId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
