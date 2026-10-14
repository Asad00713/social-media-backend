import { Injectable, Logger } from '@nestjs/common';
import { FirstWeekQueueService } from './first-week-queue.service';
import { FirstWeekRepository } from './first-week.repository';
import { FIRST_WEEK_MAX_WORKSPACE_AGE_MS } from './first-week.types';

export type TriggerResult =
  | 'started'
  | 'exists'
  | 'error'
  | 'skipped_old'
  | 'needs_description';

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
    now: Date = new Date(),
  ): Promise<TriggerResult> {
    if (!(await this.isNewWorkspace(workspaceId, now))) return 'skipped_old';
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

  /**
   * The backfill could not read the posts (failed, quota-deferred, no
   * adapter). A new workspace still gets a way forward: a
   * `needs_description` profile so Home offers Describe. No run is enqueued.
   * An existing profile is never touched.
   */
  async onBackfillUnreadable(
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<TriggerResult> {
    if (!(await this.isNewWorkspace(workspaceId, now))) return 'skipped_old';
    const created = await this.repo.insertProfileIfAbsent(workspaceId, {
      source: 'posts',
      status: 'needs_description',
    });
    return created ? 'needs_description' : 'exists';
  }

  private async isNewWorkspace(
    workspaceId: string,
    now: Date,
  ): Promise<boolean> {
    const createdAt = await this.repo.getWorkspaceCreatedAt(workspaceId);
    return (
      createdAt !== null &&
      now.getTime() - createdAt.getTime() <= FIRST_WEEK_MAX_WORKSPACE_AGE_MS
    );
  }
}
