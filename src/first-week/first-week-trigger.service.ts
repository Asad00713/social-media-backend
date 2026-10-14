import { Injectable, Logger } from '@nestjs/common';
import { FirstWeekQueueService } from './first-week-queue.service';
import { FirstWeekRepository } from './first-week.repository';

export type TriggerResult = 'started' | 'exists' | 'error';

/**
 * Starts a workspace's first week the first time a channel finishes its
 * initial backfill. The profile INSERT is the guard: `ON CONFLICT DO NOTHING`
 * means two channels connected back to back race on the primary key, one
 * wins and enqueues, the other sees the row and does nothing.
 */
@Injectable()
export class FirstWeekTriggerService {
  private readonly logger = new Logger(FirstWeekTriggerService.name);

  constructor(
    private readonly repo: FirstWeekRepository,
    private readonly queue: FirstWeekQueueService,
  ) {}

  async onChannelBackfilled(
    workspaceId: string,
    userId: string | null,
  ): Promise<TriggerResult> {
    const created = await this.repo.insertProfileIfAbsent(workspaceId, {
      source: 'posts',
      status: 'reading',
    });
    if (!created) return 'exists';

    try {
      await this.queue.enqueue({
        workspaceId,
        mode: 'posts',
        ...(userId ? { userId } : {}),
      });
      return 'started';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Could not enqueue first week for ${workspaceId}: ${message}`,
      );
      // Do not strand the row in 'reading' with no job behind it.
      await this.repo.setStatus(
        workspaceId,
        'failed',
        `Could not start: ${message}`,
      );
      return 'error';
    }
  }
}
