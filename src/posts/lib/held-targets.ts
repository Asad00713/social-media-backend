import type { BadRequestException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { posts, type PostTarget } from '../../drizzle/schema/posts.schema';
import { refusal } from './refusal';

/**
 * Targets held because their channel is paused by the user.
 *
 * A publish job that fires for a paused channel must neither fail the target
 * nor throw (a throw burns BullMQ retries and ends in "failed"). The target is
 * HELD instead: its status is left as it was, `heldAt`/`heldReason` record
 * why it did not go, and the post stays `scheduled`. Resuming the channel
 * re-enqueues the post with `heldOnly`, which publishes the held targets and
 * leaves every other target as it stands.
 */

export const HELD_REASON = 'channel_paused' as const;
/** Held because the user disconnected the channel (soft disconnect). */
export const HELD_REASON_DISCONNECTED = 'channel_disconnected' as const;
/**
 * Held because the platform's per-account rate limit is full.
 *
 * The odd one out: the other two reasons are released by a user action
 * (resuming, reconnecting), while this one releases itself at a time the
 * limiter states exactly. So a rate-limited post is enqueued for that moment
 * rather than waiting to be let go — see `holdRateLimited` and the `delayMs`
 * option on `enqueueHeldPost`.
 */
export const HELD_REASON_RATE_LIMITED = 'rate_limited' as const;
export type HeldReason =
  | typeof HELD_REASON
  | typeof HELD_REASON_DISCONNECTED
  | typeof HELD_REASON_RATE_LIMITED;

/**
 * Floor for a rate-limit retry delay.
 *
 * `retryAfterMs` can legitimately be 0 — a window that reopened between the
 * check and the hold — and retrying at once would hit the same limit and hold
 * again, in a tight loop. A minute costs nothing against windows measured in
 * hours.
 */
export const RATE_LIMIT_MIN_DELAY_MS = 60_000;

/**
 * How late a post may still publish unannounced.
 *
 * One question with one answer, asked in two places: the reconciler deciding
 * whether a post whose job vanished should still go, and the publish path
 * deciding whether to wait out a rate limit. Beyond this the post is stale —
 * publishing it would surprise the author more than skipping it — so it is
 * failed and they are told.
 *
 * It lives here, with the hold logic, rather than in either service: a
 * constant imported from a service makes the importer depend on that
 * service's whole module graph for a number.
 */
export const PUBLISH_LATE_GRACE_MS = 6 * 60 * 60 * 1000;

/**
 * Why a target that was held is failed instead of sent when its channel comes
 * back (see PublishJobData.missedHeld): its time passed long enough ago that
 * sending it now would be a silent late post.
 */
export const MISSED_HELD_MESSAGE =
  'Not sent: its time passed while the channel was disconnected. Reschedule it or publish it now.';

/** Job states in which an enqueued publish is still going to run. */
const PENDING_STATES: ReadonlySet<string> = new Set([
  'waiting',
  'delayed',
  'active',
  'prioritized',
  'waiting-children',
]);

export interface PublishJobData {
  postId: string;
  /** Resume of a paused channel: publish only the held targets. */
  heldOnly?: boolean;
  /**
   * With heldOnly: the held targets missed their time (a channel reconnected
   * long after it was disconnected). They are failed with
   * MISSED_HELD_MESSAGE rather than published late.
   */
  missedHeld?: boolean;
}

export function isHeld(target: Pick<PostTarget, 'heldAt'>): boolean {
  return typeof target.heldAt === 'string' && target.heldAt !== '';
}

/**
 * The target, held. Its status fields are deliberately not touched. The
 * reason is rewritten (a held target whose channel was then disconnected
 * reads as disconnected); the first hold time is kept.
 */
export function holdTarget<T extends PostTarget>(
  target: T,
  now: Date,
  reason: HeldReason = HELD_REASON,
): T {
  return {
    ...target,
    heldAt: isHeld(target) ? target.heldAt : now.toISOString(),
    heldReason: reason,
  };
}

/**
 * The target, held because its platform rate limit is full.
 *
 * Deliberately NOT `holdTarget(t, now, HELD_REASON_RATE_LIMITED)`:
 * `holdTarget` rewrites the reason, and the two user-caused reasons must
 * survive. A paused channel downgraded to `rate_limited` would release itself
 * on a timer and publish to a channel the user had deliberately paused — and
 * a disconnected one would publish through a channel that is gone.
 *
 * So an already-held target is returned untouched, whatever its reason. The
 * rate limit will still be there when the user resumes; this only declines to
 * take ownership of a hold it did not create.
 */
export function holdRateLimited<T extends PostTarget>(target: T, now: Date): T {
  if (isHeld(target)) return target;
  return holdTarget(target, now, HELD_REASON_RATE_LIMITED);
}

/**
 * The soonest of two retry delays, ignoring absent or nonsensical ones.
 *
 * A post can be rate-limited on several targets at once, by different limits
 * with different windows. One re-enqueue serves them all, so it goes at the
 * earliest reopening: a later target is simply held again, which is correct,
 * while going at the latest would hold the earlier ones needlessly.
 *
 * `undefined` and non-finite values are skipped rather than treated as 0 —
 * `retryAfterMs` is optional on a RateLimitResult, and reading a missing one
 * as "retry immediately" would spin.
 */
export function soonestRetry(
  current: number | null,
  candidate: number | undefined,
): number | null {
  if (candidate === undefined || !Number.isFinite(candidate)) return current;
  const next = Math.max(0, candidate);
  return current === null ? next : Math.min(current, next);
}

/** The target without its hold markers, for the attempt that releases it. */
export function releaseTarget<T extends PostTarget>(target: T): T {
  if (!('heldAt' in target) && !('heldReason' in target)) return target;
  const copy = { ...target };
  delete copy.heldAt;
  delete copy.heldReason;
  return copy;
}

/** Delay for a held post: at its time if that is still ahead, else now. */
export function resumeDelayMs(
  scheduledAt: Date | string | null,
  now: Date = new Date(),
): number {
  if (!scheduledAt) return 0;
  return Math.max(0, new Date(scheduledAt).getTime() - now.getTime());
}

/** True when `jobId` names a job that has yet to run (or is running). */
export async function isJobPending(
  queue: Pick<Queue, 'getJob'>,
  jobId: string | null | undefined,
): Promise<boolean> {
  if (!jobId) return false;
  const job = await queue.getJob(jobId);
  if (!job) return false;
  return PENDING_STATES.has(await job.getState());
}

/**
 * Enqueue the held targets of a post again and point `posts.job_id` at the
 * new job (the processor skips a job the row no longer names). The id has no
 * colon - BullMQ refuses one in a custom job id.
 */
export async function enqueueHeldPost(
  queue: Pick<Queue, 'add'>,
  db: Pick<DbType, 'update'>,
  post: { id: string; scheduledAt: Date | string | null },
  now: Date = new Date(),
  opts: { missed?: boolean; delayMs?: number } = {},
): Promise<string> {
  const jobId = `post-${post.id}-resume-${now.getTime()}`;
  const data: PublishJobData = opts.missed
    ? { postId: post.id, heldOnly: true, missedHeld: true }
    : { postId: post.id, heldOnly: true };
  const job = await queue.add('publish-post', data, {
    // A missed post is failed at once. `delayMs` is the rate-limit case: the
    // limiter knows when the window reopens, which is not the post's own
    // time — every other caller omits it and goes at the post's time, as
    // before.
    delay: opts.missed
      ? 0
      : opts.delayMs !== undefined
        ? Math.max(opts.delayMs, RATE_LIMIT_MIN_DELAY_MS)
        : resumeDelayMs(post.scheduledAt, now),
    jobId,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  });
  const id = (job.id as string) ?? jobId;
  await db.update(posts).set({ jobId: id }).where(eq(posts.id, post.id));
  return id;
}

/** A channel whose targets are held, and why. */
export interface HoldingChannel {
  name: string;
  reason: HeldReason;
}

/**
 * Why a channel holds its posts, or null when it does not. A disconnect wins
 * over a pause: reconnecting, not resuming, is what releases those posts.
 */
export function holdingReasonOf(channel: {
  pausedAt: Date | string | null;
  connectionStatus: string | null;
}): HeldReason | null {
  if (channel.connectionStatus === 'disconnected') {
    return HELD_REASON_DISCONNECTED;
  }
  return channel.pausedAt ? HELD_REASON : null;
}

/**
 * The 400 a person pressing Publish now gets when a target's channel holds
 * its posts. A disconnected channel is named first: resuming would not help.
 */
export function publishRefusalFor(
  holding: Map<string, HoldingChannel>,
): BadRequestException {
  const all = [...holding.values()];
  const disconnected = all.filter((c) => c.reason === HELD_REASON_DISCONNECTED);
  if (disconnected.length > 0) {
    const names = disconnected.map((c) => c.name).join(', ');
    return refusal(
      `Disconnected: ${names}. Reconnect ${disconnected.length === 1 ? 'it' : 'them'} to publish - scheduled posts wait until you do.`,
      'CHANNEL_DISCONNECTED',
    );
  }
  const names = all.map((c) => c.name).join(', ');
  return refusal(
    `Paused: ${names}. Resume ${all.length === 1 ? 'it' : 'them'} to publish now - scheduled posts wait until you do.`,
    'CHANNEL_PAUSED',
  );
}

/**
 * True when a held post's time passed more than `graceMs` ago: releasing it
 * would publish it late without anyone asking, so it is failed as missed.
 * A post with no time (a drip occurrence) is never missed.
 */
export function isMissedRelease(
  scheduledAt: Date | string | null,
  graceMs: number,
  now: Date = new Date(),
): boolean {
  if (!scheduledAt) return false;
  return now.getTime() - new Date(scheduledAt).getTime() > graceMs;
}
