import {
  InjectQueue,
  OnWorkerEvent,
  Processor,
  WorkerHost,
} from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { QUEUES } from '../queue/queue.module';
import { PlatformStatusService } from './platform-status.service';

/** How often every platform is measured. */
export const RECOMPUTE_EVERY_MS = 2 * 60_000;

/** The job scheduler's id: one per Redis, whatever the number of replicas. */
export const RECOMPUTE_SCHEDULER_ID = 'platform-status-recompute';
export const RECOMPUTE_JOB = 'recompute';

/**
 * Registers the repeating measurement. `upsertJobScheduler` is idempotent by
 * id, so every replica booting (and every deploy) leaves exactly one
 * schedule. One attempt per run: a failed run is simply the next run's job,
 * two minutes later, and a retry would only measure a stale window.
 */
@Injectable()
export class PlatformStatusScheduler implements OnModuleInit {
  private readonly logger = new Logger(PlatformStatusScheduler.name);

  constructor(
    @InjectQueue(QUEUES.PLATFORM_STATUS) private readonly queue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(
        RECOMPUTE_SCHEDULER_ID,
        { every: RECOMPUTE_EVERY_MS },
        {
          name: RECOMPUTE_JOB,
          data: {},
          opts: {
            attempts: 1,
            removeOnComplete: { count: 50 },
            removeOnFail: { count: 200 },
          },
        },
      );
    } catch (err) {
      // Never block boot on Redis: the status page then shows the last
      // stored states, and the next boot registers the schedule.
      this.logger.error(
        `Could not register the platform status schedule: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Runs one measurement at a time across the whole fleet. */
@Processor(QUEUES.PLATFORM_STATUS, { concurrency: 1 })
export class PlatformStatusProcessor extends WorkerHost {
  private readonly logger = new Logger(PlatformStatusProcessor.name);

  constructor(private readonly status: PlatformStatusService) {
    super();
  }

  async process(job: Job): Promise<{ changes: number }> {
    if (job.name !== RECOMPUTE_JOB) return { changes: 0 };
    const changes = await this.status.recompute();
    return { changes: changes.length };
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    this.logger.error(
      `Platform status run ${job?.id ?? '?'} failed: ${error.message}`,
    );
  }
}
