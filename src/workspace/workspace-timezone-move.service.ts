import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { DRIZZLE } from '../drizzle/drizzle.module';
import type { DbType } from '../drizzle/db';
import { socialMediaChannels } from '../drizzle/schema/channels.schema';
import { posts, type PostTarget } from '../drizzle/schema/posts.schema';
import { QUEUES } from '../queue/queue.module';
import { utcToWallClock, wallClockToUtc } from '../common/utils/wall-clock';
import { isHeld, isJobPending } from '../posts/lib/held-targets';
import { PostRescheduleService } from '../posts/services/post-reschedule.service';

/** The root db or a transaction on it: both only update here. */
type Writer = Pick<DbType, 'update'>;

/** Above this many scheduled posts the job moves run on a queue. */
export const TZ_MOVE_INLINE_LIMIT = 500;

/**
 * What "Also move existing" did. `queued` is true when the posts are being
 * moved on the queue; the counts are then the ones it will process.
 */
export interface TimezoneMoveResult {
  movedChannels: number;
  rescheduledPosts: number;
  queued: boolean;
}

/** Data of the `tz-move-<workspaceId>` job. */
export interface TimezoneMoveJob {
  workspaceId: string;
  fromZone: string;
  toZone: string;
  /** Each channel's zone before the move, by channel id. */
  channelZones: Record<string, string | null>;
}

export interface MovablePost {
  id: string;
  scheduledAt: Date | null;
  targets: PostTarget[] | null;
}

export interface PlannedMove {
  postId: string;
  at: Date;
}

/**
 * Where each post goes: the same wall-clock time, read in the zone its first
 * target channel had before the move (else `fromZone`), now in `toZone`.
 * A held post is skipped (jobless on purpose: resuming re-enqueues it), as is
 * one whose instant does not change. A new instant already past becomes `now`:
 * it publishes at once, as a past-due reschedule does.
 */
export function planPostMoves(
  rows: MovablePost[],
  channelZones: Record<string, string | null>,
  fromZone: string,
  toZone: string,
  now: Date,
): PlannedMove[] {
  const plan: PlannedMove[] = [];
  for (const row of rows) {
    if (!row.scheduledAt) continue;
    const targets = row.targets ?? [];
    if (targets.some(isHeld)) continue;
    const first = targets[0];
    const source = (first && channelZones[String(first.channelId)]) || fromZone;
    const old = new Date(row.scheduledAt);
    const wall = utcToWallClock(old, source);
    const moved = wallClockToUtc(wall.date, wall.time, toZone);
    if (!moved) continue;
    const next = moved.getTime() + old.getUTCMilliseconds();
    if (next === old.getTime()) continue;
    plan.push({ postId: row.id, at: new Date(Math.max(next, now.getTime())) });
  }
  return plan;
}

/**
 * The time zone "Also move existing" option: every channel of the workspace
 * takes the new zone, and every scheduled post keeps its local time there.
 * Channel and post rows change in one transaction; the publish jobs move after
 * it commits (PostRescheduleService), inline up to TZ_MOVE_INLINE_LIMIT posts
 * and on QUEUES.WORKSPACE_TZ_MOVE above it.
 */
@Injectable()
export class WorkspaceTimezoneMoveService {
  private readonly logger = new Logger(WorkspaceTimezoneMoveService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly reschedule: PostRescheduleService,
    @InjectQueue(QUEUES.WORKSPACE_TZ_MOVE)
    private readonly moveQueue: Queue,
  ) {}

  /**
   * A second move while one is still queued would be dropped by BullMQ (same
   * job id) and would read channel zones the first has already rewritten, so
   * it is refused before anything is written.
   */
  async assertNoMoveInProgress(workspaceId: string): Promise<void> {
    let pending = false;
    try {
      pending = await isJobPending(this.moveQueue, moveJobId(workspaceId));
    } catch (error) {
      // No queue to ask: the inline path does not need it.
      this.logger.warn(
        `Could not check for a queued time-zone move: ${errorText(error)}`,
      );
    }
    if (pending) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'TIMEZONE_MOVE_IN_PROGRESS',
        message:
          'Scheduled posts are still moving to the last time zone. Try again in a minute.',
      });
    }
  }

  async moveExisting(
    workspaceId: string,
    fromZone: string,
    toZone: string,
  ): Promise<TimezoneMoveResult> {
    const now = new Date();
    const channels = await this.db
      .select({
        id: socialMediaChannels.id,
        timezone: socialMediaChannels.timezone,
      })
      .from(socialMediaChannels)
      .where(eq(socialMediaChannels.workspaceId, workspaceId));
    const channelZones = Object.fromEntries(
      channels.map((c) => [String(c.id), c.timezone]),
    );
    const plan = planPostMoves(
      await this.scheduledPosts(workspaceId),
      channelZones,
      fromZone,
      toZone,
      now,
    );

    if (plan.length > TZ_MOVE_INLINE_LIMIT) {
      const data: TimezoneMoveJob = {
        workspaceId,
        fromZone,
        toZone,
        channelZones,
      };
      // The job is added inside the channel transaction: if Redis refuses it
      // the channels keep their zones, so a retry still knows where each
      // post's local time was read. The job reads those zones from its data,
      // never from the rows, so it may start before the commit.
      const movedChannels = await this.db.transaction(async (tx) => {
        const count = await this.moveChannels(tx, workspaceId, toZone);
        await this.moveQueue.add('move', data, {
          jobId: moveJobId(workspaceId),
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          // Gone once done, so the next move can reuse the id.
          removeOnComplete: true,
          removeOnFail: true,
        });
        return count;
      });
      return { movedChannels, rescheduledPosts: plan.length, queued: true };
    }

    const { movedChannels, moved } = await this.db.transaction(async (tx) => {
      const count = await this.moveChannels(tx, workspaceId, toZone);
      const written = await this.writePlan(tx, workspaceId, plan);
      return { movedChannels: count, moved: written };
    });

    let rescheduledPosts = 0;
    for (const move of moved) {
      try {
        await this.reschedule.moveTo(workspaceId, move.postId, move.at);
        rescheduledPosts += 1;
      } catch (error) {
        // The row already holds the new time; only its job did not move.
        // Logged and counted out, never thrown: the save itself succeeded.
        this.logger.error(
          `Time-zone move: job for post ${move.postId} not moved: ${errorText(error)}`,
        );
      }
    }
    return { movedChannels, rescheduledPosts, queued: false };
  }

  /**
   * The queued half of a large move. `enqueuedAt` (the job's creation time)
   * marks what is done: a post updated after it was moved by an earlier
   * attempt (or re-timed by a person in the new zone) and is not shifted
   * again. Every job move is retried on each attempt; any failure throws so
   * BullMQ runs the job again.
   */
  async processQueued(
    data: TimezoneMoveJob,
    enqueuedAt: Date,
  ): Promise<number> {
    const { workspaceId } = data;
    const plan = planPostMoves(
      await this.scheduledPosts(workspaceId, { updatedBefore: enqueuedAt }),
      data.channelZones,
      data.fromZone,
      data.toZone,
      new Date(),
    );
    await this.db.transaction((tx) =>
      this.writePlan(tx, workspaceId, plan, enqueuedAt),
    );

    const toArm = (
      await this.scheduledPosts(workspaceId, { updatedSince: enqueuedAt })
    ).filter((p) => p.scheduledAt && !(p.targets ?? []).some(isHeld));
    let failed = 0;
    for (const post of toArm) {
      try {
        await this.reschedule.moveTo(
          workspaceId,
          post.id,
          new Date(post.scheduledAt!),
        );
      } catch (error) {
        failed += 1;
        this.logger.error(
          `Time-zone move: job for post ${post.id} not moved: ${errorText(error)}`,
        );
      }
    }
    if (failed > 0) {
      throw new Error(
        `Time-zone move for workspace ${workspaceId}: ${failed} of ${toArm.length} jobs not moved`,
      );
    }
    return toArm.length;
  }

  private async scheduledPosts(
    workspaceId: string,
    window: { updatedBefore?: Date; updatedSince?: Date } = {},
  ): Promise<MovablePost[]> {
    return this.db
      .select({
        id: posts.id,
        scheduledAt: posts.scheduledAt,
        targets: posts.targets,
      })
      .from(posts)
      .where(
        and(
          eq(posts.workspaceId, workspaceId),
          eq(posts.status, 'scheduled'),
          isNotNull(posts.scheduledAt),
          window.updatedBefore
            ? lt(posts.updatedAt, window.updatedBefore)
            : undefined,
          window.updatedSince
            ? gte(posts.updatedAt, window.updatedSince)
            : undefined,
        ),
      );
  }

  /** Every channel not already in `toZone`; answers how many moved. */
  private async moveChannels(
    db: Writer,
    workspaceId: string,
    toZone: string,
  ): Promise<number> {
    const rows = await db
      .update(socialMediaChannels)
      .set({ timezone: toZone, updatedAt: new Date() })
      .where(
        and(
          eq(socialMediaChannels.workspaceId, workspaceId),
          sql`${socialMediaChannels.timezone} IS DISTINCT FROM ${toZone}`,
        ),
      )
      .returning({ id: socialMediaChannels.id });
    return rows.length;
  }

  /** The new instants; answers the moves whose post was still scheduled. */
  private async writePlan(
    db: Writer,
    workspaceId: string,
    plan: PlannedMove[],
    updatedBefore?: Date,
  ): Promise<PlannedMove[]> {
    const written: PlannedMove[] = [];
    for (const move of plan) {
      const rows = await db
        .update(posts)
        .set({ scheduledAt: move.at, updatedAt: new Date() })
        .where(
          and(
            eq(posts.id, move.postId),
            eq(posts.workspaceId, workspaceId),
            eq(posts.status, 'scheduled'),
            updatedBefore ? lt(posts.updatedAt, updatedBefore) : undefined,
          ),
        )
        .returning({ id: posts.id });
      if (rows.length > 0) written.push(move);
    }
    return written;
  }
}

/** No colon: BullMQ refuses one in a custom job id. */
function moveJobId(workspaceId: string): string {
  return `tz-move-${workspaceId}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
