import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { DbType } from '../../drizzle/db';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import { QUEUES } from '../../queue/queue.module';
import {
  enqueueHeldPost,
  HELD_REASON,
  HELD_REASON_RATE_LIMITED,
  holdTarget,
  isHeld,
  isJobPending,
  isMissedRelease,
  releaseTarget,
} from '../../posts/lib/held-targets';
import { posts, type PostTarget } from '../../drizzle/schema/posts.schema';
import type {
  PauseChannelResponse,
  ResumeChannelResponse,
} from '../dto/channel-hub.dto';
import { loadPeople, personOf } from '../lib/people';
import { livePosts } from '../../posts/soft-delete/soft-delete';

type Row = Record<string, unknown>;

/** What bringing a disconnected channel back did to its held posts. */
export interface ReleaseHeldResult {
  /** Will go out: at their own time, or now (see overdueCount). */
  resumedCount: number;
  /** Of resumedCount: their time passed during the disconnect; going now. */
  overdueCount: number;
  /** Missed by more than the grace: failed as missed, not sent late. */
  missedCount: number;
  /** Still held because the channel is also paused (resume sends them). */
  stillPausedCount: number;
}

function rowsOf(result: unknown): Row[] {
  const r = result as { rows?: Row[] } | Row[];
  return Array.isArray(r) ? r : (r.rows ?? []);
}

/**
 * The user's pause, kept apart from the plan lock.
 *
 * `is_active = false` is the billing reconciler's "locked by your plan" and
 * is never touched here. A pause is `paused_at`: while it is set, posts can
 * still be scheduled to the channel, and a publish job that fires for it
 * HOLDS the target (PostService.publishPost) rather than failing it. Resume
 * clears the pause and re-enqueues every held post - at its own time if
 * that is still ahead, at once if it passed during the pause.
 */
@Injectable()
export class ChannelPauseService {
  private readonly logger = new Logger(ChannelPauseService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    @InjectQueue(QUEUES.POST_PUBLISHING)
    private readonly publishingQueue: Queue,
  ) {}

  /**
   * Pause the channel. Idempotent: pausing a paused channel keeps the
   * original time and person.
   */
  async pause(
    workspaceId: string,
    channelId: number,
    userId: string,
  ): Promise<PauseChannelResponse> {
    await this.assertChannel(workspaceId, channelId);

    // Only an unpaused row is stamped, so a second pause (or two at once)
    // never moves pausedAt or changes who paused it.
    await this.db
      .update(socialMediaChannels)
      .set({
        pausedAt: new Date(),
        pausedByUserId: userId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(socialMediaChannels.id, channelId),
          eq(socialMediaChannels.workspaceId, workspaceId),
          isNull(socialMediaChannels.pausedAt),
        ),
      );

    const [row] = await this.db
      .select({
        pausedAt: socialMediaChannels.pausedAt,
        pausedByUserId: socialMediaChannels.pausedByUserId,
      })
      .from(socialMediaChannels)
      .where(eq(socialMediaChannels.id, channelId))
      .limit(1);
    if (!row?.pausedAt) {
      // Deleted between the two statements.
      throw new NotFoundException('Channel not found');
    }

    const [people, heldCount] = await Promise.all([
      loadPeople(this.db, [row.pausedByUserId]),
      this.countScheduled(workspaceId, channelId),
    ]);
    this.logger.log(
      `Channel ${channelId} paused by ${userId}; ${heldCount} scheduled post(s) wait`,
    );
    return {
      pausedAt: new Date(row.pausedAt).toISOString(),
      pausedBy: personOf(people, row.pausedByUserId),
      heldCount,
    };
  }

  /**
   * Resume the channel and send what it held. Idempotent: on a channel that
   * is not paused it still re-enqueues any held post that has no live job
   * (repairing a lost enqueue), and never enqueues one twice - a post whose
   * job is still waiting is left to that job.
   */
  async resume(
    workspaceId: string,
    channelId: number,
  ): Promise<ResumeChannelResponse> {
    await this.assertChannel(workspaceId, channelId);

    // Clear first, then look: a publish job racing this resume either sees
    // the pause gone, or writes its hold before the scan below - and
    // PostService re-checks the pause after holding, for the case in between.
    await this.db
      .update(socialMediaChannels)
      .set({ pausedAt: null, pausedByUserId: null, updatedAt: new Date() })
      .where(
        and(
          eq(socialMediaChannels.id, channelId),
          eq(socialMediaChannels.workspaceId, workspaceId),
        ),
      );

    const held = await this.heldPostsOf(workspaceId, channelId);
    let requeued = 0;
    for (const post of held) {
      if (await isJobPending(this.publishingQueue, post.jobId)) continue;
      await enqueueHeldPost(this.publishingQueue, this.db, post);
      requeued++;
    }

    const resumedCount = await this.countScheduled(workspaceId, channelId);
    this.logger.log(
      `Channel ${channelId} resumed; ${requeued} held post(s) re-enqueued, ${resumedCount} will go out`,
    );
    return { resumedCount };
  }

  /**
   * Targets on this channel still to go out on scheduled posts: upcoming,
   * overdue and held alike. Reads both target status fields.
   */
  async countScheduled(
    workspaceId: string,
    channelId: number,
  ): Promise<number> {
    const result = await this.db.execute(sql`
      SELECT count(*)::int AS n
      FROM posts p
      CROSS JOIN LATERAL jsonb_array_elements(p.targets) e
      WHERE p.workspace_id = ${workspaceId}
        AND p.status = 'scheduled'
        AND e->>'channelId' = ${String(channelId)}
        AND COALESCE(e->>'status', '') NOT IN ('published', 'failed')
        AND COALESCE(e->>'publishStatus', '') NOT IN ('published', 'failed')
    `);
    return Number(rowsOf(result)[0]?.n ?? 0);
  }

  /** Scheduled posts holding a target for this channel. */
  async heldPostsOf(
    workspaceId: string,
    channelId: number,
  ): Promise<
    Array<{ id: string; scheduledAt: Date | null; jobId: string | null }>
  > {
    const result = await this.db.execute(sql`
      SELECT p.id, p.scheduled_at, p.job_id
      FROM posts p
      WHERE p.workspace_id = ${workspaceId}
        AND p.status = 'scheduled'
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(p.targets) e
          WHERE e->>'channelId' = ${String(channelId)}
            AND e->>'heldAt' IS NOT NULL
        )
      ORDER BY p.scheduled_at ASC NULLS FIRST, p.id
    `);
    return rowsOf(result).map((r) => ({
      id: String(r.id),
      scheduledAt: r.scheduled_at ? new Date(r.scheduled_at as string) : null,
      jobId: (r.job_id as string | null) ?? null,
    }));
  }

  /**
   * A disconnected channel is back (an undo, or a reconnect that revived the
   * row). For every scheduled post holding a target on it:
   *  - its publish job still waits (the post's time is ahead): the hold
   *    markers come off this channel's targets, so the Planner shows it as
   *    scheduled again, and that job sends it at its time;
   *  - no job waits and its time is ahead or passed at most `graceMs` ago:
   *    re-enqueued (at its time, or at once - `overdueCount`), the pause
   *    resume rule;
   *  - its time passed more than `graceMs` ago: enqueued as missed, which
   *    fails the target with MISSED_HELD_MESSAGE - never published late
   *    without anyone asking.
   * A channel that is also paused keeps every post held: the targets are
   * relabelled as paused, and resuming sends them.
   *
   * Call after the row is no longer 'disconnected' (a publish job racing
   * this then sees the channel back and does not re-hold).
   */
  async releaseAfterReconnect(
    workspaceId: string,
    channelId: number,
    graceMs: number,
    now: Date = new Date(),
  ): Promise<ReleaseHeldResult> {
    const result: ReleaseHeldResult = {
      resumedCount: 0,
      overdueCount: 0,
      missedCount: 0,
      stillPausedCount: 0,
    };
    const [channel] = await this.db
      .select({ pausedAt: socialMediaChannels.pausedAt })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.id, channelId),
          eq(socialMediaChannels.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!channel) return result;
    const isPaused = !!channel.pausedAt;
    const id = String(channelId);

    const held = await this.heldPostsOf(workspaceId, channelId);
    for (const post of held) {
      const jobWaits = await isJobPending(this.publishingQueue, post.jobId);
      if (isPaused || jobWaits) {
        // Rewrite this channel's markers: a pause keeps the hold (as a
        // pause); a waiting job sends the post itself, so no hold remains.
        //
        // A rate-limit hold is left exactly as it is. It is not this
        // channel's to release: relabelling it `channel_paused` would stop it
        // releasing itself on its own timer and make it wait for a resume the
        // user has no reason to expect, while its retry job fires into a
        // paused target and holds it again — the post would never publish.
        // Stripping it would be no better: the limit is still full.
        await this.db.transaction(async (tx) => {
          const [row] = await tx
            .select({ targets: posts.targets })
            .from(posts)
            .where(and(eq(posts.id, post.id), livePosts()))
            .for('update');
          if (!row) return;
          const targets = (row.targets ?? []).map((t: PostTarget) =>
            String(t.channelId) === id &&
            isHeld(t) &&
            t.heldReason !== HELD_REASON_RATE_LIMITED
              ? isPaused
                ? holdTarget(t, now, HELD_REASON)
                : releaseTarget(t)
              : t,
          );
          await tx
            .update(posts)
            .set({ targets, updatedAt: now })
            .where(eq(posts.id, post.id));
        });
        if (isPaused) result.stillPausedCount++;
        else result.resumedCount++;
        continue;
      }
      if (isMissedRelease(post.scheduledAt, graceMs, now)) {
        await enqueueHeldPost(this.publishingQueue, this.db, post, now, {
          missed: true,
        });
        result.missedCount++;
        continue;
      }
      await enqueueHeldPost(this.publishingQueue, this.db, post, now);
      result.resumedCount++;
      if (post.scheduledAt && post.scheduledAt.getTime() <= now.getTime()) {
        result.overdueCount++;
      }
    }
    this.logger.log(
      `Channel ${channelId} is back: ${result.resumedCount} post(s) resume (${result.overdueCount} overdue), ${result.missedCount} missed, ${result.stillPausedCount} still paused`,
    );
    return result;
  }

  private async assertChannel(
    workspaceId: string,
    channelId: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(channelId) || channelId <= 0) {
      throw new NotFoundException('Channel not found');
    }
    const [row] = await this.db
      .select({
        id: socialMediaChannels.id,
        connectionStatus: socialMediaChannels.connectionStatus,
      })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.id, channelId),
          eq(socialMediaChannels.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('Channel not found');
    // A disconnected channel already holds its posts; the undo or a
    // reconnect releases them, not a pause or a resume.
    if (row.connectionStatus === 'disconnected') {
      throw new ConflictException({
        statusCode: 409,
        message: 'This channel is disconnected. Reconnect it first.',
        error: 'Conflict',
        code: 'CHANNEL_DISCONNECTED',
      });
    }
  }
}
