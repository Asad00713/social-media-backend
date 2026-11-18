import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUES } from '../queue/queue.module';
import {
  WorkspaceTimezoneMoveService,
  type TimezoneMoveJob,
} from './workspace-timezone-move.service';

/** Moves the scheduled posts of a time-zone change too large to do inline. */
@Processor(QUEUES.WORKSPACE_TZ_MOVE)
export class WorkspaceTimezoneMoveProcessor extends WorkerHost {
  private readonly logger = new Logger(WorkspaceTimezoneMoveProcessor.name);

  constructor(private readonly moves: WorkspaceTimezoneMoveService) {
    super();
  }

  async process(job: Job<TimezoneMoveJob>): Promise<number> {
    const moved = await this.moves.processQueued(job.data);
    this.logger.log(
      `Time-zone move for workspace ${job.data.workspaceId}: ${moved} posts re-armed in ${job.data.toZone}`,
    );
    return moved;
  }
}
