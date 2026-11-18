import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Cron } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { and, eq, lt, isNotNull } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { posts } from '../../drizzle/schema';
import { QUEUES } from '../../queue/queue.module';
import {
  isJobPending,
  isHeld,
  PUBLISH_LATE_GRACE_MS,
} from '../lib/held-targets';
import { livePosts } from '../soft-delete/soft-delete';

/**
 * How far past its time a post may be re-armed and still sent.
 *
 * Past this it is failed rather than published: a post written for Monday
 * morning going out on Thursday afternoon is worse than one that did not go
 * out at all, and the author can see the failure and decide.
 *
 * Six hours is chosen for the outage this exists for. A Redis restart is
 * seconds; a Redis *restore from backup* can be an hour or two. Six hours
 * covers that while still refusing to publish yesterday's post today.
 */
// PUBLISH_LATE_GRACE_MS now lives in lib/held-targets.ts: the publish path
// asks the same question when it decides whether to wait out a rate limit.

/**
 * Only consider posts whose time has been settled for a moment.
 *
 * `publishingQueue.add()` and the `job_id` write that follows it are two
 * statements, not one. A post enqueued microseconds ago can legitimately have
 * no `job_id` yet, and re-arming it would race the job that already exists.
 */
const SETTLE_MS = 2 * 60 * 1000;

/** Rows per pass. A backlog drains over successive runs rather than at once. */
const BATCH = 500;

/** Shown to the author on a post the reconciler found too late to send. */
export const MISSED_SCHEDULE_MESSAGE =
  'Not published: its scheduled time passed while the publishing queue was unavailable. Reschedule it or publish it now.';

export interface ReconcileResult {
  checked: number;
  rearmed: number;
  failedAsMissed: number;
}

/**
 * Re-arms scheduled posts whose publish job is no longer in Redis.
 *
 * A scheduled post lives in two places: the `posts` row says *what* and
 * *when*, and a delayed BullMQ job in Redis is the only thing that actually
 * *fires*. Nothing reconciled the two. If Redis lost data — an eviction under
 * memory pressure, a restart without persistence, a restore from a backup
 * taken before the post was scheduled — the row stayed `scheduled` and its
 * time simply passed. No error, no notification, no trace: the post never
 * went out and the author found out from the silence.
 *
 * Postgres is the record; this makes Redis match it again.
 *
 * ## What it does, per post
 *
 * | State | Action |
 * |---|---|
 * | job still waiting in Redis | nothing — it will fire |
 * | job gone, time ahead or recently passed | re-enqueued at its own time |
 * | job gone, time passed > 6h ago | failed as missed, never published late |
 *
 * ## Why re-arming cannot double-post
 *
 * Two guards, both pre-existing:
 *
 * - `isJobPending` is checked first, so a post whose job is still queued is
 *   left alone.
 * - The processor refuses a post that is not `scheduled`
 *   (`post-publish.processor.ts:55`), so even if a duplicate job were somehow
 *   enqueued, only one publishes and the other skips.
 *
 * ## Why a completed job looks the same as a lost one
 *
 * Completed jobs are dropped from Redis after 24h (`queue.module.ts`), so
 * "no job" alone proves nothing. What makes it safe is the pairing: a job
 * that *ran* moved the post out of `scheduled`. A row still `scheduled` with
 * no pending job is genuinely unarmed, whatever became of its job.
 *
 * Runs every 15 minutes and once at boot — the boot pass is what recovers a
 * deploy that follows a Redis incident. On healthy data it finds nothing.
 *
 * `ScheduleModule.forRoot()` is registered in AppModule.
 */
@Injectable()
export class ScheduledPostReconcilerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScheduledPostReconcilerService.name);

  constructor(
    @InjectQueue(QUEUES.POST_PUBLISHING)
    private readonly publishingQueue: Queue,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    // Not awaited: boot must neither wait on nor fail with a repair pass.
    void this.reconcile().catch((error: unknown) => {
      this.logger.error(
        `Boot scheduled-post reconcile failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  @Cron('*/15 * * * *', { timeZone: 'UTC', name: 'scheduledPostReconcile' })
  async quarterHourly(): Promise<void> {
    await this.reconcile();
  }

  async reconcile(now: Date = new Date()): Promise<ReconcileResult> {
    const result: ReconcileResult = {
      checked: 0,
      rearmed: 0,
      failedAsMissed: 0,
    };

    const candidates = await db
      .select({
        id: posts.id,
        scheduledAt: posts.scheduledAt,
        jobId: posts.jobId,
        targets: posts.targets,
      })
      .from(posts)
      .where(and(and(
          eq(posts.status, 'scheduled'),
          isNotNull(posts.scheduledAt),
          // Settled rows only — see SETTLE_MS.
          lt(posts.updatedAt, new Date(now.getTime() - SETTLE_MS)),
        ), livePosts()))
      .limit(BATCH);

    result.checked = candidates.length;
    if (candidates.length === 0) return result;

    for (const post of candidates) {
      try {
        // A post holding a target on a paused or disconnected channel is
        // `scheduled` with no publish job ON PURPOSE: resuming or reconnecting
        // the channel is what sends it (see held-targets.ts and
        // ChannelPauseService.releaseAfterReconnect). Re-arming it here would
        // publish to a channel the user deliberately paused.
        if ((post.targets ?? []).some(isHeld)) continue;

        if (await isJobPending(this.publishingQueue, post.jobId)) continue;

        const scheduledAt = new Date(post.scheduledAt as Date);
        const lateBy = now.getTime() - scheduledAt.getTime();

        if (lateBy > PUBLISH_LATE_GRACE_MS) {
          await this.failAsMissed(post.id, scheduledAt, now);
          result.failedAsMissed += 1;
        } else {
          await this.rearm(post.id, scheduledAt, now);
          result.rearmed += 1;
        }
      } catch (error) {
        // One bad row must not abandon the rest of the batch.
        this.logger.error(
          `Could not reconcile post ${post.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (result.rearmed > 0 || result.failedAsMissed > 0) {
      this.logger.warn(
        `Scheduled-post reconcile: ${result.rearmed} re-armed, ` +
          `${result.failedAsMissed} failed as missed, of ${result.checked} checked`,
      );
    }

    return result;
  }

  /** Enqueue a publish job for a post that has none, at its own time. */
  private async rearm(
    postId: string,
    scheduledAt: Date,
    now: Date,
  ): Promise<void> {
    const delay = Math.max(0, scheduledAt.getTime() - now.getTime());
    // No colon: BullMQ refuses one in a custom job id.
    const jobId = `post-${postId}-rearm-${now.getTime()}`;

    const job = await this.publishingQueue.add(
      'publish-post',
      { postId },
      { delay, jobId, attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
    );

    // The processor skips a job the row no longer names, so this write is
    // what makes the new job the live one.
    await db
      .update(posts)
      .set({ jobId: (job.id as string) ?? jobId, updatedAt: now })
      .where(
        // Guarded: if the post left `scheduled` since the batch was read,
        // write nothing rather than point it at a job that will not run.
        and(eq(posts.id, postId), eq(posts.status, 'scheduled')),
      );

    this.logger.log(
      `Re-armed post ${postId} for ${scheduledAt.toISOString()} (delay ${delay}ms)`,
    );
  }

  /**
   * Fail a post whose time passed too long ago to publish now.
   *
   * Deliberately not published late: the author sees a failed post and
   * decides whether it is still worth sending, which is a better outcome than
   * a Monday-morning post appearing on Thursday afternoon.
   */
  private async failAsMissed(
    postId: string,
    scheduledAt: Date,
    now: Date,
  ): Promise<void> {
    await db
      .update(posts)
      .set({
        status: 'failed',
        lastError: MISSED_SCHEDULE_MESSAGE,
        updatedAt: now,
      })
      .where(and(eq(posts.id, postId), eq(posts.status, 'scheduled')));

    this.logger.warn(
      `Post ${postId} missed its schedule (${scheduledAt.toISOString()}) and was failed`,
    );
  }
}
