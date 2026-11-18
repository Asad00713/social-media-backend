import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import { DRIZZLE } from '../drizzle/drizzle.module';
import type { DbType } from '../drizzle/db';
import { socialMediaChannels } from '../drizzle/schema/channels.schema';
import { posts, type PostTarget } from '../drizzle/schema/posts.schema';
import { QUEUES } from '../queue/queue.module';
import { utcToWallClock, wallClockToUtc } from '../common/utils/wall-clock';
import { isHeld, isJobPending } from '../posts/lib/held-targets';
import { PostRescheduleService } from '../posts/services/post-reschedule.service';

/** The root db or a transaction on it. */
export type Executor = Pick<DbType, 'select' | 'update' | 'execute'>;

/**
 * Above this many posts to move, the job moves run on the queue: each post
 * costs a handful of DB and Redis round trips, too many for one request.
 */
export const TZ_MOVE_INLINE_LIMIT = 100;

/** Batch size when the queued job reads its posts back. */
const READ_BATCH = 500;

/**
 * What "Also move existing" did. `queued` is true when the posts are being
 * moved on the queue; the counts are then the ones it will process.
 * `unmovedPosts`: posts left on their previous time. That is a post someone
 * re-timed, published or cancelled while the move ran (theirs to keep), or
 * one whose publish job could not be moved (logged; its row and its live job
 * still agree). Inline only: a queued move answers 0 and logs its own.
 */
export interface TimezoneMoveResult {
  movedChannels: number;
  rescheduledPosts: number;
  queued: boolean;
  unmovedPosts: number;
}

/** One planned post move, as the queued job carries it (ISO instants). */
export interface QueuedPostMove {
  id: string;
  /** `scheduled_at` when the move was planned. */
  from: string;
  /** Where it goes. */
  to: string;
}

/** Data of the `tz-move-<workspaceId>` job. */
export interface TimezoneMoveJob {
  workspaceId: string;
  fromZone: string;
  toZone: string;
  /** Each channel's zone before the move, by channel id. */
  channelZones: Record<string, string | null>;
  /**
   * The plan, fixed when the move was asked for. A post is shifted only
   * while it still holds `from`, so a retry never shifts it twice and a post
   * someone re-timed in between is left alone.
   */
  posts: QueuedPostMove[];
}

export interface MoveExistingOptions {
  /** A write that must commit with the move, or not at all. */
  writeFirst?: (tx: Executor) => Promise<void>;
}

export interface MovablePost {
  id: string;
  scheduledAt: Date | null;
  targets: PostTarget[] | null;
}

export interface PlannedMove {
  postId: string;
  from: Date;
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
    plan.push({
      postId: row.id,
      from: old,
      at: new Date(Math.max(next, now.getTime())),
    });
  }
  return plan;
}

/**
 * The time zone "Also move existing" option: every channel of the workspace
 * takes the new zone, and every scheduled post keeps its local time there.
 *
 * One transaction, under a per-workspace advisory lock, checks no move is
 * queued, moves the channels and either writes the posts' new instants
 * (up to TZ_MOVE_INLINE_LIMIT) or enqueues the plan on
 * QUEUES.WORKSPACE_TZ_MOVE. Publish jobs move after the commit
 * (PostRescheduleService); a post whose job cannot be moved is put back on
 * its old time, so its row and its job always agree.
 *
 * Campaign posts are never moved: a campaign keeps its own zone and its slot
 * rows hold their own times.
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
   * `options.writeFirst` runs inside the locked transaction, after the
   * in-progress check and before anything else is written: the settings row
   * goes there, so a 409 saves nothing and the row commits (or rolls back)
   * with the channels and the plan.
   */
  async moveExisting(
    workspaceId: string,
    fromZone: string,
    toZone: string,
    options: MoveExistingOptions = {},
  ): Promise<TimezoneMoveResult> {
    const now = new Date();
    const outcome = await this.db.transaction(async (tx) => {
      // Two moves of one workspace never interleave: the second waits here,
      // then reads the zones and times the first committed.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`tz-move:${workspaceId}`}))`,
      );

      const channels = await tx
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
        await this.scheduledPosts(tx, workspaceId),
        channelZones,
        fromZone,
        toZone,
        now,
      );
      const queued = plan.length > TZ_MOVE_INLINE_LIMIT;

      await this.claimMoveJobId(workspaceId, queued);
      await options.writeFirst?.(tx);
      const movedChannels = await this.moveChannels(tx, workspaceId, toZone);

      if (queued) {
        const data: TimezoneMoveJob = {
          workspaceId,
          fromZone,
          toZone,
          channelZones,
          posts: plan.map((m) => ({
            id: m.postId,
            from: m.from.toISOString(),
            to: m.at.toISOString(),
          })),
        };
        // Inside the transaction: if Redis refuses the job, the channels
        // keep their zones and nothing has moved. The job works from its own
        // plan, never from the rows, so it may start before the commit.
        await this.moveQueue.add('move', data, {
          jobId: moveJobId(workspaceId),
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          // A move that failed every attempt stays visible for a week;
          // claimMoveJobId frees the id for the next move.
          removeOnFail: { age: 7 * 24 * 3600 },
        });
        return {
          movedChannels,
          queuedCount: plan.length,
          written: [],
          notWritten: 0,
        };
      }

      const written = await this.writePlan(tx, workspaceId, plan);
      return {
        movedChannels,
        queuedCount: 0,
        written,
        notWritten: plan.length - written.length,
      };
    });

    if (outcome.queuedCount > 0) {
      return {
        movedChannels: outcome.movedChannels,
        rescheduledPosts: outcome.queuedCount,
        queued: true,
        unmovedPosts: 0,
      };
    }

    const { moved, failed, skipped } = await this.armAll(
      workspaceId,
      outcome.written,
    );
    return {
      movedChannels: outcome.movedChannels,
      rescheduledPosts: moved,
      queued: false,
      // Planned but changed before the write, changed before the job moved,
      // or whose job could not move.
      unmovedPosts: outcome.notWritten + skipped + failed,
    };
  }

  /**
   * The queued half of a large move. Each planned post still at its planned
   * `from` is shifted to `to`; one already at `to` (an earlier attempt that
   * stopped before its job moved) is only re-armed; any other is left to
   * whoever re-timed it. A post whose job cannot be moved goes back to `from`
   * and the job throws, so BullMQ tries again.
   */
  async processQueued(data: TimezoneMoveJob): Promise<number> {
    const { workspaceId } = data;
    const current = new Map<string, MovablePost & { status: string }>();
    for (let i = 0; i < data.posts.length; i += READ_BATCH) {
      const ids = data.posts.slice(i, i + READ_BATCH).map((p) => p.id);
      const rows = await this.db
        .select({
          id: posts.id,
          scheduledAt: posts.scheduledAt,
          targets: posts.targets,
          status: posts.status,
        })
        .from(posts)
        .where(and(eq(posts.workspaceId, workspaceId), inArray(posts.id, ids)));
      for (const row of rows) current.set(row.id, row);
    }

    const toArm: PlannedMove[] = [];
    let leftAlone = 0;
    for (const p of data.posts) {
      const row = current.get(p.id);
      if (
        !row?.scheduledAt ||
        row.status !== 'scheduled' ||
        (row.targets ?? []).some(isHeld)
      ) {
        leftAlone += 1;
        continue;
      }
      const move = { postId: p.id, from: new Date(p.from), at: new Date(p.to) };
      const at = new Date(row.scheduledAt).getTime();
      if (at === move.from.getTime()) {
        const [shifted] = await this.writePlan(this.db, workspaceId, [move]);
        if (shifted) toArm.push(shifted);
        else leftAlone += 1;
      } else if (at === move.at.getTime()) {
        toArm.push(move);
      } else {
        leftAlone += 1;
      }
    }

    const { moved, failed, skipped } = await this.armAll(workspaceId, toArm);
    if (leftAlone + skipped > 0) {
      this.logger.warn(
        `Time-zone move for workspace ${workspaceId}: ${leftAlone + skipped} posts left on their previous time (changed while the move ran)`,
      );
    }
    if (failed > 0) {
      throw new Error(
        `Time-zone move for workspace ${workspaceId}: ${failed} of ${toArm.length} jobs not moved`,
      );
    }
    return moved;
  }

  /**
   * Moves the publish job of every post whose row now holds its new time.
   * A post whose job cannot be moved is put back on its old time.
   */
  private async armAll(
    workspaceId: string,
    moves: PlannedMove[],
  ): Promise<{ moved: number; failed: number; skipped: number }> {
    let moved = 0;
    let failed = 0;
    let skipped = 0;
    for (const move of moves) {
      try {
        const outcome = await this.reschedule.moveTo(
          workspaceId,
          move.postId,
          move.at,
          // The live job fires at `from` until this moves it.
          { ifScheduledAt: move.at, previousAt: move.from },
        );
        if (outcome === 'moved') moved += 1;
        else skipped += 1;
      } catch (error) {
        failed += 1;
        this.logger.error(
          `Time-zone move: post ${move.postId} left at its old time, its job could not be moved: ${errorText(error)}`,
        );
        await this.restore(workspaceId, move);
      }
    }
    return { moved, failed, skipped };
  }

  /** Puts a post whose job did not move back on the time its job has. */
  private async restore(workspaceId: string, move: PlannedMove): Promise<void> {
    try {
      await this.db
        .update(posts)
        .set({ scheduledAt: move.from })
        .where(
          and(
            eq(posts.id, move.postId),
            eq(posts.workspaceId, workspaceId),
            eq(posts.status, 'scheduled'),
            sameInstant(move.at),
          ),
        );
    } catch (error) {
      this.logger.error(
        `Time-zone move: could not restore post ${move.postId} to ${move.from.toISOString()}: ${errorText(error)}`,
      );
    }
  }

  /**
   * Drops a queued move of a workspace being deleted. Best effort: a move
   * already running cannot be removed, and finds no posts once the workspace
   * is gone (processQueued then only logs them as left alone).
   */
  async cancelPendingMove(workspaceId: string): Promise<void> {
    const id = moveJobId(workspaceId);
    try {
      const job = await this.moveQueue.getJob(id);
      if (job) await job.remove();
    } catch (error) {
      this.logger.warn(
        `Could not cancel the time-zone move ${id}: ${errorText(error)}`,
      );
    }
  }

  /**
   * Refuses a move while the last one is still queued (409), and frees the
   * fixed job id of a finished one: BullMQ silently ignores an `add` whose id
   * exists. `strict` (the queued path): a queue error refuses the move too,
   * since a job that cannot be added would leave the posts behind.
   */
  private async claimMoveJobId(
    workspaceId: string,
    strict: boolean,
  ): Promise<void> {
    const id = moveJobId(workspaceId);
    try {
      if (await isJobPending(this.moveQueue, id)) throw moveInProgress();
      const job = await this.moveQueue.getJob(id);
      if (job) await job.remove();
    } catch (error) {
      if (error instanceof ConflictException || strict) throw error;
      // The inline path does not need the queue.
      this.logger.warn(
        `Could not check for a queued time-zone move: ${errorText(error)}`,
      );
    }
  }

  /**
   * Scheduled posts that may move. Campaign posts never do: a campaign has
   * its own zone and its slot rows their own times. A bulk or drip slot links
   * its post through campaign_slot_content.post_id; every post a campaign
   * materialises (evergreen occurrences included) also carries
   * metadata.campaignSlot. A composer post the user merely filed under a
   * campaign carries only metadata.campaignId (draft-organise.ts) and moves
   * like any other post; campaignSlot is the codebase's own marker for a
   * materialised one (workspace-posts.query.ts).
   */
  private async scheduledPosts(
    db: Executor,
    workspaceId: string,
  ): Promise<MovablePost[]> {
    return db
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
          sql`NOT EXISTS (SELECT 1 FROM campaign_slot_content c WHERE c.post_id = ${posts.id})`,
          sql`(${posts.metadata} -> 'campaignSlot') IS NULL`,
        ),
      );
  }

  /** Every channel not already in `toZone`; answers how many moved. */
  private async moveChannels(
    db: Executor,
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

  /**
   * The new instants, each written only while the post is still scheduled at
   * its planned `from`; answers the moves that were written.
   */
  private async writePlan(
    db: Executor,
    workspaceId: string,
    plan: PlannedMove[],
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
            sameInstant(move.from),
          ),
        )
        .returning({ id: posts.id });
      if (rows.length > 0) written.push(move);
    }
    return written;
  }
}

/**
 * `scheduled_at` equals `at` to the millisecond. A JS Date holds
 * milliseconds and Postgres microseconds: a row written by SQL would never
 * compare equal to the Date it was read back as.
 */
function sameInstant(at: Date): SQL {
  return sql`date_trunc('milliseconds', ${posts.scheduledAt}) = ${at.toISOString()}::timestamptz`;
}

/** No colon: BullMQ refuses one in a custom job id. */
function moveJobId(workspaceId: string): string {
  return `tz-move-${workspaceId}`;
}

function moveInProgress(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'TIMEZONE_MOVE_IN_PROGRESS',
    message:
      'Scheduled posts are still moving to the last time zone. Try again in a minute.',
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
