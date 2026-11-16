import {
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Queue } from 'bullmq';
import { and, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { DbType } from '../../drizzle/db';
import {
  socialMediaChannels,
  isBillablePlatform,
  type SupportedPlatform,
} from '../../drizzle/schema/channels.schema';
import { posts, type PostTarget } from '../../drizzle/schema/posts.schema';
import { QUEUES } from '../../queue/queue.module';
import { AccountChannelsService } from '../../billing/services/account-channels.service';
import { CalendarSubscriptionService } from '../../calendar-sync/services/calendar-subscription.service';
import {
  HELD_REASON_DISCONNECTED,
  holdTarget,
  isHeld,
  releaseTarget,
} from '../../posts/lib/held-targets';
import { workspaceUsage } from '../../drizzle/schema';
import { ChannelSyncLifecycleService } from '../analytics/services/channel-sync-lifecycle.service';
import {
  CHANNEL_RESTORE_WINDOW_MS,
  MUST_DELETE_ON_DISCONNECT,
  mustDeleteOnDisconnect,
  restoreDeadline,
} from '../lib/disconnect-policy';
import { isDisconnected } from '../lib/live-channel';
import type {
  DisconnectChannelResponse,
  RestoreChannelResponse,
} from '../dto/channel-disconnect.dto';
import { ChannelService } from './channel.service';
import { ChannelPauseService } from './channel-pause.service';
import { ChannelPostsCleanupService } from './channel-posts-cleanup.service';
import { GOOGLE_PLATFORMS, GoogleOauthRevokeService } from './google-oauth-revoke.service';
import { TelegramService } from './telegram.service';

type ChannelRow = typeof socialMediaChannels.$inferSelect;

/** The finalize job: which disconnect it closes (a later one has its own). */
export interface FinalizeDisconnectJob {
  channelId: number;
  /** ISO time of the disconnect this job belongs to. */
  disconnectedAt: string;
}

export type FinalizeOutcome =
  | 'gone'
  | 'restored'
  | 'already-finalized'
  | 'tokens-cleared'
  | 'deleted';

/** Platforms one account can be connected to in only one workspace at a time. */
const GLOBALLY_UNIQUE_PLATFORMS: ReadonlySet<string> = new Set([
  'telegram',
  'whatsapp',
]);

/** Extra time the sweep waits past the window for the job to do its work. */
const SWEEP_GRACE_MS = 2 * 60 * 1000;

const isoOrNull = (d: Date | null): string | null =>
  d ? new Date(d).toISOString() : null;

/** BullMQ refuses a colon in a custom job id. */
export function finalizeJobId(channelId: number, disconnectedAt: Date): string {
  return `channel-finalize-${channelId}-${disconnectedAt.getTime()}`;
}

export { restoreDeadline };

function conflict(message: string, code: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    message,
    error: 'Conflict',
    code,
  });
}

/**
 * Soft disconnect: a disconnected channel keeps its history, pauses its
 * scheduled posts, and can be undone for CHANNEL_RESTORE_WINDOW_MS.
 *
 *  disconnect  -> status 'disconnected', sync stopped, slot given back,
 *                 scheduled posts held (Planner shows them paused), and a
 *                 delayed finalize job queued.
 *  restore     -> (the undo; only inside the window, before finalize) the
 *                 slot is taken back under the account ceiling, status as it
 *                 was, sync re-armed, held posts released.
 *  finalize    -> (the job, or the sweep if the job was lost) external
 *                 teardown (Telegram webhook, Google grant) and the tokens
 *                 cleared - or, for a platform whose policy requires it
 *                 (disconnect-policy.ts), the old hard delete. Idempotent;
 *                 a no-op when the channel was restored or reconnected.
 *  deleteHistory / integrations -> the old hard delete, at once, no undo.
 *
 * A reconnect of the same account after finalize revives the row
 * (ChannelService.createChannel), so its history comes back.
 */
@Injectable()
export class ChannelDisconnectService {
  private readonly logger = new Logger(ChannelDisconnectService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly channels: ChannelService,
    private readonly heldPosts: ChannelPauseService,
    private readonly postsCleanup: ChannelPostsCleanupService,
    private readonly syncLifecycle: ChannelSyncLifecycleService,
    private readonly googleRevoke: GoogleOauthRevokeService,
    private readonly telegram: TelegramService,
    @Inject(forwardRef(() => CalendarSubscriptionService))
    private readonly calendarSubscription: CalendarSubscriptionService,
    @Inject(forwardRef(() => AccountChannelsService))
    private readonly accountChannels: AccountChannelsService,
    @InjectQueue(QUEUES.CHANNEL_DISCONNECT)
    private readonly finalizeQueue: Queue,
  ) {}

  // ==========================================================================
  // Disconnect
  // ==========================================================================

  async disconnect(
    workspaceId: string,
    channelId: number,
    userId: string,
    opts: { deleteHistory?: boolean } = {},
    now: Date = new Date(),
  ): Promise<DisconnectChannelResponse> {
    const row = await this.load(workspaceId, channelId);
    const platform = row.platform as SupportedPlatform;

    // Integrations (cloud storage, calendars) have no history to keep and
    // hold no slot: removed at once, as before. So is any channel whose
    // history the user asked to delete.
    if (opts.deleteHistory || !isBillablePlatform(platform)) {
      await this.hardDelete(row);
      return {
        outcome: 'deleted',
        channelId,
        restoreUntil: null,
        historyKept: false,
        pausedCount: 0,
      };
    }

    if (!isDisconnected(row)) {
      const [marked] = await this.db
        .update(socialMediaChannels)
        .set({
          connectionStatus: 'disconnected',
          disconnectedAt: now,
          disconnectedByUserId: userId,
          statusBeforeDisconnect: row.connectionStatus,
          disconnectFinalizedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(socialMediaChannels.id, channelId),
            ne(socialMediaChannels.connectionStatus, 'disconnected'),
          ),
        )
        .returning({ id: socialMediaChannels.id });

      // Lost a race with a second disconnect: that one did the work.
      if (marked) {
        await this.afterSoftDisconnect(row, now);
      }
    }

    const current = await this.load(workspaceId, channelId);
    const pausedCount = await this.heldPosts.countScheduled(
      workspaceId,
      channelId,
    );
    return {
      outcome: 'disconnected',
      channelId,
      restoreUntil: isoOrNull(restoreDeadline(current, now)),
      historyKept: !mustDeleteOnDisconnect(platform),
      pausedCount,
    };
  }

  /** Everything a soft disconnect does after the row is marked. */
  private async afterSoftDisconnect(row: ChannelRow, now: Date): Promise<void> {
    const { id: channelId, workspaceId } = row;

    // Sync stops now (queued snapshot jobs removed, next sync parked).
    try {
      await this.syncLifecycle.onChannelDisconnected(channelId);
    } catch (error) {
      this.logger.warn(
        `Disconnect ${channelId}: could not stop sync: ${messageOf(error)}`,
      );
    }

    // The slot is free at once: the live COUNT already excludes the row;
    // the legacy counter and the plan-locked channels follow.
    try {
      await this.channels.releaseSlot(workspaceId, channelId);
    } catch (error) {
      this.logger.warn(
        `Disconnect ${channelId}: slot release failed (the nightly sweep repairs it): ${messageOf(error)}`,
      );
    }

    // Its scheduled posts read as paused in the Planner at once; a publish
    // job that fires before the undo holds them too (PostService). The row
    // is already marked: a failure here must not answer 500 and lose the
    // Undo - the publish job holds them anyway.
    let held = 0;
    try {
      held = await this.holdScheduled(workspaceId, channelId, now);
    } catch (error) {
      this.logger.error(
        `Disconnect ${channelId}: could not mark its scheduled posts paused (their jobs hold them): ${messageOf(error)}`,
      );
    }

    // A lost job is recovered by the sweep (every 5 minutes).
    try {
      await this.finalizeQueue.add(
        'finalize-disconnect',
        {
          channelId,
          disconnectedAt: now.toISOString(),
        } satisfies FinalizeDisconnectJob,
        {
          jobId: finalizeJobId(channelId, now),
          delay: CHANNEL_RESTORE_WINDOW_MS,
          attempts: 5,
          backoff: { type: 'exponential', delay: 30_000 },
        },
      );
    } catch (error) {
      this.logger.error(
        `Disconnect ${channelId}: finalize job not queued (the sweep finalizes it): ${messageOf(error)}`,
      );
    }

    this.logger.log(
      `Channel ${channelId} (${row.platform}) disconnected; ${held} scheduled post(s) paused; finalize in ${CHANNEL_RESTORE_WINDOW_MS / 60000} min`,
    );
  }

  /**
   * Hold every still-to-go target of this channel on its scheduled posts,
   * as a publish job would (held-targets.ts), so the Planner shows them
   * paused before their time. Returns how many posts it touched.
   */
  private async holdScheduled(
    workspaceId: string,
    channelId: number,
    now: Date,
  ): Promise<number> {
    const id = String(channelId);
    let touched = 0;
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: posts.id, targets: posts.targets })
        .from(posts)
        .where(
          and(
            eq(posts.workspaceId, workspaceId),
            eq(posts.status, 'scheduled'),
            sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${posts.targets}) AS t WHERE t->>'channelId' = ${id})`,
          ),
        )
        .for('update');
      for (const row of rows) {
        let dirty = false;
        const targets = (row.targets ?? []).map((t: PostTarget) => {
          if (String(t.channelId) !== id || isTerminal(t)) return t;
          dirty = true;
          return holdTarget(t, now, HELD_REASON_DISCONNECTED);
        });
        if (!dirty) continue;
        await tx
          .update(posts)
          .set({ targets, updatedAt: now })
          .where(eq(posts.id, row.id));
        touched++;
      }
    });
    return touched;
  }

  // ==========================================================================
  // Restore (the undo)
  // ==========================================================================

  async restore(
    workspaceId: string,
    channelId: number,
    now: Date = new Date(),
  ): Promise<RestoreChannelResponse> {
    const row = await this.load(workspaceId, channelId);

    // Already back (a second click, or a reconnect got there first).
    if (!isDisconnected(row)) {
      return {
        channelId,
        connectionStatus: row.connectionStatus,
        resumedCount: 0,
        overdueCount: 0,
        missedCount: 0,
        stillPausedCount: 0,
      };
    }

    if (!restoreDeadline(row, now)) {
      throw conflict(
        'It’s too late to undo this disconnect. Reconnect the channel instead.',
        'RESTORE_WINDOW_CLOSED',
      );
    }

    const billable = isBillablePlatform(row.platform as SupportedPlatform);
    const ownerId = billable
      ? await this.accountChannels.ownerOf(workspaceId)
      : null;

    // The slot is taken back under the same advisory lock a new channel
    // takes, so an undo can never walk past the ceiling (409
    // CHANNEL_LIMIT_REACHED, from enforceWithinTransaction).
    const restored = await this.db.transaction(async (tx) => {
      if (ownerId) {
        await this.accountChannels.enforceWithinTransaction(tx, ownerId);
      }
      // A bot or WhatsApp number can live in one workspace only: if another
      // workspace connected it meanwhile, this one cannot take it back.
      // Inside the transaction, after the account lock.
      if (
        GLOBALLY_UNIQUE_PLATFORMS.has(row.platform) &&
        (await this.isLiveElsewhere(row, tx))
      ) {
        throw conflict(
          'This account is now connected in another workspace.',
          'CHANNEL_CONNECTED_ELSEWHERE',
        );
      }
      const updated = await tx
        .update(socialMediaChannels)
        .set({
          connectionStatus: restoredStatus(row.statusBeforeDisconnect),
          disconnectedAt: null,
          disconnectedByUserId: null,
          statusBeforeDisconnect: null,
          disconnectFinalizedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(socialMediaChannels.id, channelId),
            eq(socialMediaChannels.connectionStatus, 'disconnected'),
            isNull(socialMediaChannels.disconnectFinalizedAt),
            // This very disconnect, not a later one.
            eq(socialMediaChannels.disconnectedAt, row.disconnectedAt!),
          ),
        )
        .returning({
          connectionStatus: socialMediaChannels.connectionStatus,
        });
      // The slot is counted in the same transaction as the status change.
      if (updated.length > 0 && billable) {
        await tx
          .update(workspaceUsage)
          .set({
            channelsCount: sql`${workspaceUsage.channelsCount} + 1`,
            updatedAt: now,
          })
          .where(eq(workspaceUsage.workspaceId, workspaceId));
      }
      return updated;
    });

    if (restored.length === 0) {
      // Finalize claimed it between the read and the write.
      throw conflict(
        'It’s too late to undo this disconnect. Reconnect the channel instead.',
        'RESTORE_WINDOW_CLOSED',
      );
    }


    // The finalize job would no-op now; remove it so it never runs at all.
    try {
      const job = await this.finalizeQueue.getJob(
        finalizeJobId(channelId, new Date(row.disconnectedAt!)),
      );
      if (job) await job.remove();
    } catch (error) {
      this.logger.warn(
        `Restore ${channelId}: finalize job not removed (it no-ops): ${messageOf(error)}`,
      );
    }

    try {
      await this.syncLifecycle.onChannelConnected(channelId, workspaceId);
    } catch (error) {
      this.logger.warn(
        `Restore ${channelId}: sync not re-armed (the daily scheduler picks it up): ${messageOf(error)}`,
      );
    }

    const released = await this.heldPosts.releaseAfterReconnect(
      workspaceId,
      channelId,
      CHANNEL_RESTORE_WINDOW_MS,
      now,
    );
    this.logger.log(`Channel ${channelId} restored (undo)`);
    return {
      channelId,
      connectionStatus: restored[0].connectionStatus,
      ...released,
    };
  }

  // ==========================================================================
  // Finalize (job + sweep)
  // ==========================================================================

  /**
   * Close the undo window of one disconnect. Idempotent and safe to run
   * twice or on two instances: the row is claimed under FOR UPDATE, and a
   * restored, reconnected or re-disconnected channel is left alone.
   */
  async finalize(
    channelId: number,
    disconnectedAt: Date,
  ): Promise<FinalizeOutcome> {
    const [row] = await this.db
      .select()
      .from(socialMediaChannels)
      .where(eq(socialMediaChannels.id, channelId))
      .limit(1);
    if (!row) return 'gone';
    if (
      !isDisconnected(row) ||
      !row.disconnectedAt ||
      new Date(row.disconnectedAt).getTime() !== disconnectedAt.getTime()
    ) {
      return 'restored';
    }

    const mustDelete = mustDeleteOnDisconnect(row.platform);

    // Claim: tokens read and cleared in one transaction, so exactly one run
    // tears down and an undo is refused from here on.
    const claimed = await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(socialMediaChannels)
        .where(
          and(
            eq(socialMediaChannels.id, channelId),
            eq(socialMediaChannels.connectionStatus, 'disconnected'),
            eq(socialMediaChannels.disconnectedAt, row.disconnectedAt!),
          ),
        )
        .for('update');
      if (!locked) return null;
      if (locked.disconnectFinalizedAt && !mustDelete) return null;
      if (!mustDelete) {
        await tx
          .update(socialMediaChannels)
          .set({
            accessToken: '',
            refreshToken: null,
            tokenExpiresAt: null,
            refreshTokenIssuedAt: null,
            disconnectFinalizedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(socialMediaChannels.id, channelId));
      } else if (!locked.disconnectFinalizedAt) {
        // Marked first so a crash before the delete is retried by the sweep
        // (it re-finds finalized must-delete rows) and no undo slips in.
        await tx
          .update(socialMediaChannels)
          .set({ disconnectFinalizedAt: new Date(), updatedAt: new Date() })
          .where(eq(socialMediaChannels.id, channelId));
      }
      return locked;
    });
    if (!claimed) return 'already-finalized';

    if (mustDelete) {
      // The old hard delete: its unpublished posts go, the cascades take its
      // history, the Google grant is revoked if it was the last one - only
      // while the row is still this disconnect (a revive is refused on a
      // claimed row, and the delete re-checks).
      await this.hardDelete(claimed, { onlyIfDisconnectedAt: row.disconnectedAt });
      this.logger.log(
        `Channel ${channelId} (${row.platform}) finalized: deleted (policy: ${MUST_DELETE_ON_DISCONNECT[row.platform as SupportedPlatform]?.source ?? 'unknown platform'})`,
      );
      return 'deleted';
    }

    await this.teardownExternal(claimed);
    // History is kept but the channel does not come back on its own: its
    // paused posts resolve as failed instead of waiting forever.
    try {
      const failed = await this.failHeldPosts(claimed.workspaceId, channelId);
      if (failed > 0) {
        this.logger.log(
          `Channel ${channelId} finalized: ${failed} paused post(s) marked failed`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Channel ${channelId} finalized but its paused posts were not resolved: ${messageOf(error)}`,
      );
    }
    this.logger.log(
      `Channel ${channelId} (${row.platform}) finalized: history kept, tokens cleared`,
    );
    return 'tokens-cleared';
  }

  /**
   * The job is the normal path; this catches a disconnect whose job was lost
   * (Redis flushed, a deploy between enqueue and run) and a must-delete row
   * whose delete crashed after it was claimed.
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'finalizeChannelDisconnects' })
  async sweep(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(
      now.getTime() - CHANNEL_RESTORE_WINDOW_MS - SWEEP_GRACE_MS,
    );
    const mustDeletePlatforms = Object.entries(MUST_DELETE_ON_DISCONNECT)
      .filter(([, p]) => p.mustDelete)
      .map(([platform]) => platform);
    const due = await this.db
      .select({
        id: socialMediaChannels.id,
        disconnectedAt: socialMediaChannels.disconnectedAt,
      })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.connectionStatus, 'disconnected'),
          isNotNull(socialMediaChannels.disconnectedAt),
          lt(socialMediaChannels.disconnectedAt, cutoff),
          or(
            isNull(socialMediaChannels.disconnectFinalizedAt),
            inArray(socialMediaChannels.platform, mustDeletePlatforms),
          ),
        ),
      )
      .limit(100);
    let done = 0;
    for (const row of due) {
      try {
        const outcome = await this.finalize(row.id, row.disconnectedAt!);
        if (outcome === 'deleted' || outcome === 'tokens-cleared') done++;
      } catch (error) {
        this.logger.error(
          `Sweep could not finalize channel ${row.id}: ${messageOf(error)}`,
        );
      }
    }
    return done;
  }

  // ==========================================================================
  // Hard delete and teardown
  // ==========================================================================

  /**
   * The old disconnect: webhook / push-subscription teardown while the token
   * is still here, the channel's unpublished posts removed (Buffer's rule),
   * then the row (FK cascades take its history). Used for deleteHistory,
   * integrations and must-delete platforms.
   */
  private async hardDelete(
    row: ChannelRow,
    opts: { onlyIfDisconnectedAt?: Date | null } = {},
  ): Promise<void> {
    const token = isDisconnected(row)
      ? this.channels.readStoredAccessToken(row)
      : null;
    try {
      // The same bot live in another workspace (connected during the undo
      // window) shares the webhook: never pull it out from under that one.
      if (row.platform === 'telegram' && !(await this.isLiveElsewhere(row))) {
        const t =
          token ??
          (isDisconnected(row)
            ? null
            : await this.channels.getAccessToken(row.id, row.workspaceId));
        if (t) await this.telegram.forToken(t).deleteWebhook();
      }
      if (
        row.platform === 'google_calendar' ||
        row.platform === 'outlook_calendar'
      ) {
        await this.calendarSubscription.teardown(row.id);
      }
    } catch (error) {
      this.logger.warn(
        `Webhook teardown on disconnect failed (non-blocking): ${messageOf(error)}`,
      );
    }
    // Before the row: a failure here leaves the channel and the user can
    // retry, rather than a deleted channel with posts still aimed at it.
    await this.postsCleanup.removeUnpublished(row.workspaceId, row.id);
    await this.channels.deleteChannel(row.id, row.workspaceId, {
      onlyIfDisconnectedAt: opts.onlyIfDisconnectedAt ?? undefined,
    });
  }

  /**
   * True when the same platform account is live (not disconnected) in a row
   * other than this one - another workspace connected it meanwhile. Shared
   * external state (a Telegram webhook, a Google grant) must then be left.
   */
  private async isLiveElsewhere(
    row: ChannelRow,
    executor: Pick<DbType, 'select'> = this.db,
  ): Promise<boolean> {
    const others = await executor
      .select({ id: socialMediaChannels.id })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.platform, row.platform),
          eq(socialMediaChannels.platformAccountId, row.platformAccountId),
          ne(socialMediaChannels.id, row.id),
          ne(socialMediaChannels.connectionStatus, 'disconnected'),
        ),
      )
      .limit(1);
    return others.length > 0;
  }

  /**
   * A kept-history channel was finalized: every scheduled post still holding
   * a target on it gets that target failed ("Channel disconnected"), and a
   * post with nothing left to send resolves (failed, or partly published).
   * A reconnect later does not resend them - they are visible and retryable.
   */
  async failHeldPosts(workspaceId: string, channelId: number): Promise<number> {
    const id = String(channelId);
    const now = new Date();
    let touched = 0;
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: posts.id, targets: posts.targets })
        .from(posts)
        .where(
          and(
            eq(posts.workspaceId, workspaceId),
            eq(posts.status, 'scheduled'),
            sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${posts.targets}) AS t WHERE t->>'channelId' = ${id} AND t->>'heldAt' IS NOT NULL)`,
          ),
        )
        .for('update');
      for (const row of rows) {
        const targets = (row.targets ?? []).map((t: PostTarget) =>
          String(t.channelId) === id && isHeld(t)
            ? {
                ...releaseTarget(t),
                status: 'failed' as const,
                errorMessage: CHANNEL_DISCONNECTED_MESSAGE,
              }
            : t,
        );
        const status = resolvedStatus(targets);
        await tx
          .update(posts)
          .set({
            targets,
            ...(status ? { status, lastError: CHANNEL_DISCONNECTED_MESSAGE } : {}),
            updatedAt: now,
          })
          .where(eq(posts.id, row.id));
        touched++;
      }
    });
    return touched;
  }

  /** Teardown for a kept disconnected channel, with the token just cleared. */
  private async teardownExternal(row: ChannelRow): Promise<void> {
    const token = this.channels.readStoredAccessToken(row);
    if (!token) return;
    try {
      // Shared with a live row elsewhere (connected during the window): leave it.
      if (await this.isLiveElsewhere(row)) return;
      if (row.platform === 'telegram') {
        await this.telegram.forToken(token).deleteWebhook();
      }
      if (GOOGLE_PLATFORMS.includes(row.platform)) {
        // The refresh token revokes the grant itself; a stored access token
        // has usually expired by now and its revoke is a no-op.
        await this.googleRevoke.revokeIfLastGoogleChannel(
          row.id,
          row.workspaceId,
          row.platform,
          this.channels.readStoredRevokeToken(row) ?? token,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Teardown of disconnected channel ${row.id} failed (non-blocking): ${messageOf(error)}`,
      );
    }
  }

  private async load(
    workspaceId: string,
    channelId: number,
  ): Promise<ChannelRow> {
    if (!Number.isSafeInteger(channelId) || channelId <= 0) {
      throw new NotFoundException('Channel not found');
    }
    const [row] = await this.db
      .select()
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.id, channelId),
          eq(socialMediaChannels.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('Channel not found');
    return row;
  }
}

/** Why a finalized channel's paused posts failed. */
export const CHANNEL_DISCONNECTED_MESSAGE =
  'Not sent: the channel was disconnected. Reconnect it and reschedule the post.';

/** What an undo puts back: never a transient 'refreshing'. */
export function restoredStatus(before: string | null): string {
  if (!before || before === 'refreshing') return 'connected';
  return before;
}

/**
 * A post's status once a target was failed: null while something is still
 * to go; else failed, or partly published when some target went out.
 */
export function resolvedStatus(
  targets: PostTarget[],
): 'failed' | 'partially_published' | null {
  const isOut = (t: PostTarget) =>
    t.status === 'published' ||
    (t as PostTarget & { publishStatus?: string }).publishStatus ===
      'published';
  const pending = targets.some((t) => !isOut(t) && t.status !== 'failed');
  if (pending) return null;
  return targets.some(isOut) ? 'partially_published' : 'failed';
}

/** A target that already went out or failed is history, never held. */
function isTerminal(t: PostTarget): boolean {
  const s = t as PostTarget & { publishStatus?: string };
  return (
    t.status === 'published' ||
    t.status === 'failed' ||
    s.publishStatus === 'published' ||
    s.publishStatus === 'failed'
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
