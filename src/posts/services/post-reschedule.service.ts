import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { DbType } from '../../drizzle/db';
import { posts } from '../../drizzle/schema/posts.schema';
import { QUEUES } from '../../queue/queue.module';
import { livePosts, liveWorkspacePosts } from '../soft-delete/soft-delete';

/** What moveTo did: re-armed the post, or found it no longer movable. */
export type RescheduleOutcome = 'moved' | 'not-movable';

export interface MoveToOptions {
  /**
   * Move only while the row still holds this instant. A caller that wrote
   * the new time itself passes it, so a post someone re-timed in between is
   * left to them.
   */
  ifScheduledAt?: Date;
  /**
   * When the post's live job fires today. If the new job cannot be added
   * after the old one was removed, the old one is put back at this time so
   * the post is never left without a job. Defaults to the row's time as
   * read here; a caller that already wrote the new time passes the old one.
   */
  previousAt?: Date;
}

/**
 * Moves one scheduled post to a new instant: the row and its publish job
 * together, the way the composer re-schedules a draft
 * (ComposerSchedulingService.schedule). The job id is the composer's own,
 * `composer-publish-<postId>` (no colon: BullMQ refuses one), and it is
 * recorded on the row, because PostService and the cleanup paths cancel by
 * it and by `posts.job_id`.
 *
 * Callers pass only posts that are not held: a held post is jobless on
 * purpose and resuming its channel is what re-enqueues it.
 *
 * Concurrency: the whole move of one post (guard, job swap, job id write)
 * runs in one transaction holding the post's row lock (SELECT ... FOR
 * UPDATE). Two moves of the same post therefore run one after the other,
 * and a writer that changes `scheduled_at` meanwhile waits for the job swap
 * to finish, so the row's time and its live job cannot be left from two
 * different moves. A row lock rather than a workspace-wide lock: it is held
 * only for this post's few Redis calls, and it also orders this against any
 * other writer of the row, not only against another time-zone move.
 *
 * Failures:
 * - the old composer job cannot be removed: throws before adding anything
 *   (adding the same id would be a BullMQ no-op that hands back the OLD
 *   job); the transaction rolls back, nothing changed;
 * - `add` throws after the old job was removed: the old job is put back at
 *   `previousAt` under the composer id, then this throws and the row rolls
 *   back, so the post keeps a live job at its previous time;
 * - the job id write fails after `add`: retried once, then logged. The new
 *   time is kept, since it is what the live job fires at.
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
    return this.db.transaction(async (tx): Promise<RescheduleOutcome> => {
      const [row] = await tx
        .select({ jobId: posts.jobId, scheduledAt: posts.scheduledAt })
        .from(posts)
        .where(
          and(
            eq(posts.id, postId),
            eq(posts.workspaceId, workspaceId),
            eq(posts.status, 'scheduled'),
            // Never re-arm a deleted post, or a post of a deleted workspace:
            // this is the read that decides whether a publish job is added.
            livePosts(),
            liveWorkspacePosts(),
            options.ifScheduledAt
              ? sql`date_trunc('milliseconds', ${posts.scheduledAt}) = ${options.ifScheduledAt.toISOString()}::timestamptz`
              : undefined,
          ),
        )
        .for('update');
      // Published, cancelled, deleted (or its workspace deleted) or re-timed
      // in the meantime: whoever did that owns its job, which is left alone.
      if (!row) {
        this.logger.log(`Post ${postId} is no longer movable; not re-armed`);
        return 'not-movable';
      }

      await tx
        .update(posts)
        .set({ scheduledAt: at })
        .where(eq(posts.id, postId));

      const jobId = `composer-publish-${postId}`;
      // Must be free, or `add` below hands back the old job.
      await this.removeJob(jobId, true);
      // A leftover under the recorded id is harmless once the row names the
      // new job (the processor skips a job the row does not name): logged.
      if (row.jobId && row.jobId !== jobId) {
        await this.removeJob(row.jobId, false);
      }

      let job: { id?: string } | undefined;
      try {
        job = await this.addPublish(postId, jobId, at);
      } catch (error) {
        const previousAt = options.previousAt ?? row.scheduledAt;
        await this.putBack(postId, jobId, previousAt);
        throw error;
      }

      const recorded = String(job?.id ?? jobId);
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          // A savepoint: a failed statement would otherwise abort the whole
          // transaction and take the new time with it.
          await tx.transaction((sp) =>
            sp
              .update(posts)
              .set({ jobId: recorded })
              .where(eq(posts.id, postId)),
          );
          break;
        } catch (error) {
          if (attempt === 2) {
            this.logger.error(
              `Post ${postId}: job ${recorded} is live at ${at.toISOString()} but its id could not be recorded on the row: ${errorText(error)}`,
            );
          }
        }
      }
      return 'moved';
    });
  }

  private addPublish(
    postId: string,
    jobId: string,
    at: Date,
  ): Promise<{ id?: string }> {
    return this.publishingQueue.add(
      'publish',
      { postId },
      { jobId, delay: Math.max(0, at.getTime() - Date.now()), attempts: 3 },
    );
  }

  /** The old job back at its old time, so the post is never jobless. */
  private async putBack(
    postId: string,
    jobId: string,
    previousAt: Date | null,
  ): Promise<void> {
    try {
      if (!previousAt) throw new Error('it had no time');
      await this.addPublish(postId, jobId, new Date(previousAt));
    } catch (error) {
      this.logger.error(
        `Post ${postId} has NO publish job: neither the new one nor its old one (${previousAt ? new Date(previousAt).toISOString() : 'no time'}) could be added: ${errorText(error)}`,
      );
    }
  }

  /** A job that is already gone is not an error. */
  private async removeJob(id: string, required: boolean): Promise<void> {
    try {
      const job = await this.publishingQueue.getJob(id);
      if (job) await job.remove();
    } catch (error) {
      const message = `Failed to remove job ${id}: ${errorText(error)}`;
      if (required) throw new Error(message);
      this.logger.warn(message);
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
