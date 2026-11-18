import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { DbType } from '../../drizzle/db';
import { posts } from '../../drizzle/schema/posts.schema';
import { QUEUES } from '../../queue/queue.module';

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
 */
@Injectable()
export class PostRescheduleService {
  private readonly logger = new Logger(PostRescheduleService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    @InjectQueue(QUEUES.POST_PUBLISHING)
    private readonly publishingQueue: Queue,
  ) {}

  async moveTo(workspaceId: string, postId: string, at: Date): Promise<void> {
    const [row] = await this.db
      .update(posts)
      .set({ scheduledAt: at })
      .where(
        and(
          eq(posts.id, postId),
          eq(posts.workspaceId, workspaceId),
          eq(posts.status, 'scheduled'),
        ),
      )
      .returning({ jobId: posts.jobId });
    // Published, cancelled or deleted in the meantime: nothing to re-arm.
    if (!row) {
      this.logger.log(`Post ${postId} is no longer scheduled; not moved`);
      return;
    }

    const jobId = `composer-publish-${postId}`;
    await this.removeJobs(jobId, row.jobId);

    const job = await this.publishingQueue.add(
      'publish',
      { postId },
      { jobId, delay: Math.max(0, at.getTime() - Date.now()), attempts: 3 },
    );

    await this.db
      .update(posts)
      .set({ jobId: String(job?.id ?? jobId) })
      .where(and(eq(posts.id, postId), eq(posts.workspaceId, workspaceId)));
  }

  /**
   * The composer's job and, when it differs, the one the row records. A job
   * that is already gone is not an error; one that cannot be removed is
   * logged, as the composer does.
   */
  private async removeJobs(
    composerJobId: string,
    recordedJobId: string | null,
  ): Promise<void> {
    const ids = new Set([composerJobId]);
    if (recordedJobId) ids.add(recordedJobId);
    for (const id of ids) {
      try {
        const job = await this.publishingQueue.getJob(id);
        if (job) await job.remove();
      } catch (error) {
        this.logger.warn(
          `Failed to remove job ${id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
