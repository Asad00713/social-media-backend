import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { QUEUES } from '../queue/queue.module';
import type { FirstWeekJobData } from './first-week.types';

/**
 * Enqueues a first-week run. One job per workspace at a time: the job id is
 * derived from the workspace (no colon, BullMQ rejects it) and finished jobs
 * are removed, so a second add while one is waiting/active is ignored by
 * BullMQ and a retry after completion is not swallowed by a leftover job.
 */
@Injectable()
export class FirstWeekQueueService {
  constructor(@InjectQueue(QUEUES.FIRST_WEEK) private readonly queue: Queue) {}

  static jobIdFor(workspaceId: string): string {
    return `first-week-${workspaceId}`;
  }

  async enqueue(data: FirstWeekJobData): Promise<void> {
    await this.queue.add('first-week', data, {
      jobId: FirstWeekQueueService.jobIdFor(data.workspaceId),
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  }
}
