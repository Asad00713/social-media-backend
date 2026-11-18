import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { DbType } from '../../drizzle/db';
import { posts } from '../../drizzle/schema/posts.schema';
import { QUEUES } from '../../queue/queue.module';

/** What moveTo did: re-armed the post, or found it no longer movable. */
export type RescheduleOutcome = 'moved' | 'not-movable';

export interface MoveToOptions {
  /**
   * Move only while the row still holds this instant. A caller that wrote
   * the new time itself passes it, so a post someone re-timed in between is
   * left to them.
   */
  ifScheduledAt?: Date;
}

/**
 * Moves one scheduled post to a new instant: the row and its publish job
 * together, the way the composer re-schedules a draft
 * (ComposerSchedulingService.schedule). The job id is the composer's own,
 * `composer-publish-<postId>` (no colon: BullMQ refuses one), and it is
 * recorded on the row, because the publish processor skips a job the row
 * does not name and PostService cancels by `posts.job_id`.
 *
 * Callers pass only posts that are not held: a held post is jobless on
 * purpose and resuming its channel is what re-enqueues it.
 *
 * Throws, before adding anything, when the old composer job cannot be
 * removed: adding the same id would then be a BullMQ no-op that hands back
 * the OLD job, and the post would publish at its old time while the row
 * shows the new one. The row already holds `at` by then: the caller puts
 * its old time back, so row and job agree again.
 */
@Injectable()
export class PostRescheduleService {
  private readonly logger = new Logger(PostRescheduleService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    @InjectQueue(QUEUES.POST_PUBLISHING)
    private readonly publishingQueue: Queue,
  ) {}

  async moveTo(
    workspaceId: string,
    postId: string,
    at: Date,
    options: MoveToOptions = {},
  ): Promise<RescheduleOutcome> {
    const [row] = await this.db
      .update(posts)
      .set({ scheduledAt: at })
      .where(
        and(
          eq(posts.id, postId),
          eq(posts.workspaceId, workspaceId),
          eq(posts.status, 'scheduled'),
          options.ifScheduledAt
            ? eq(posts.scheduledAt, options.ifScheduledAt)
            : undefined,
        ),
      )
      .returning({ jobId: posts.jobId });
    // Published, cancelled, deleted or re-timed in the meantime: whoever did
    // that owns its job, which is left alone.
    if (!row) {
      this.logger.log(`Post ${postId} is no longer movable; not re-armed`);
      return 'not-movable';
    }

    const jobId = `composer-publish-${postId}`;
    // Must be free, or `add` below hands back the old job. On a throw here
    // the row already holds `at`; the caller restores its old time.
    await this.removeJob(jobId, true);
    // A leftover under the recorded id is harmless once the row names the
    // new job (the processor skips a job the row does not name): logged.
    if (row.jobId && row.jobId !== jobId) {
      await this.removeJob(row.jobId, false);
    }

    const job = await this.publishingQueue.add(
      'publish',
      { postId },
      { jobId, delay: Math.max(0, at.getTime() - Date.now()), attempts: 3 },
    );

    await this.db
      .update(posts)
      .set({ jobId: String(job?.id ?? jobId) })
      .where(and(eq(posts.id, postId), eq(posts.workspaceId, workspaceId)));
    return 'moved';
  }

  /** A job that is already gone is not an error. */
  private async removeJob(id: string, required: boolean): Promise<void> {
    try {
      const job = await this.publishingQueue.getJob(id);
      if (job) await job.remove();
    } catch (error) {
      const message = `Failed to remove job ${id}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      if (required) throw new Error(message);
      this.logger.warn(message);
    }
  }
}
