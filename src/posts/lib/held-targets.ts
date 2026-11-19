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
/**
 * Held because the platform failed in a way that is worth trying again - a
 * 502/503/504, a dropped connection, a timeout.
 *
 * `classifyPublishError` has always computed `retryable` for exactly these
 * (code `transient`), and nothing read it: every caller took `.code` and threw
 * the flag away. So a target whose platform returned "503 Service
 * Unavailable" was written `status: 'failed'` and the per-target catch
 * swallowed the error, so the job COMPLETED and BullMQ never retried either.
 * The customer's post was dead because the platform hiccuped for a minute.
 *
 * Grouped with `rate_limited` rather than the two user-caused reasons: nothing
 * but time releases it, so it is re-enqueued on a timer and
 * `isHeldByUserAction` must answer false for it.
 */
export const HELD_REASON_TRANSIENT = 'transient_error' as const;
export type HeldReason =
  | typeof HELD_REASON
  | typeof HELD_REASON_DISCONNECTED
  | typeof HELD_REASON_RATE_LIMITED
  | typeof HELD_REASON_TRANSIENT;

/** The reasons that release themselves on a timer, with no user action. */
const SELF_RELEASING: ReadonlySet<string> = new Set([
  HELD_REASON_RATE_LIMITED,
  HELD_REASON_TRANSIENT,
]);

/**
 * True when this hold releases itself on a timer rather than by a user action.
 *
 * Exported as one predicate rather than left as a comparison at each site,
 * because the sites are the thing that goes wrong: the release paths were
 * written `heldReason !== HELD_REASON_RATE_LIMITED` when `rate_limited` was
 * the only self-releasing reason, and every one of them had to be found again
 * when a second appeared. A `!isSelfReleasing(t)` reads the same before and
 * after a third.
 */
export function isSelfReleasing(
  target: Pick<PostTarget, 'heldReason'>,
): boolean {
  return SELF_RELEASING.has(target.heldReason ?? '');
}

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
 * True when the target is held for a reason only a person can clear — a
 * paused or disconnected channel.
 *
 * The distinction matters wherever code decides whether it may send a held
 * post. A user-caused hold must be left alone: re-arming it would publish to
 * a channel someone deliberately paused. A `rate_limited` hold is the
 * opposite — nothing but time releases it, so leaving it alone forever is the
 * failure mode, and anything that recovers lost jobs has to be allowed to
 * rebuild its retry.
 */
export function isHeldByUserAction(
  target: Pick<PostTarget, 'heldAt' | 'heldReason'>,
): boolean {
  return isHeld(target) && !isSelfReleasing(target);
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
 * The target, held because the platform failed transiently.
 *
 * Same refusal to downgrade an existing hold as `holdRateLimited`, and for the
 * same reason: a paused or disconnected channel must not be turned into
 * something that releases itself on a timer.
 *
 * `errorMessage` and `errorCode` are kept rather than cleared - the attempt
 * really did fail, and the author seeing "Service unavailable, retrying" is
 * better than a silent wait - but `status` is left exactly as it was, so the
 * post is still `scheduled` rather than `failed`.
 */
export function holdTransient<T extends PostTarget>(
  target: T,
  now: Date,
  errorMessage: string,
): T {
  if (isHeld(target)) return target;
  return {
    ...holdTarget(target, now, HELD_REASON_TRANSIENT),
    errorMessage,
    errorCode: 'transient',
  };
}

/**
 * How long to wait before trying a transiently-failed target again.
 *
 * A platform outage is not a rate-limit window with a published reopening
 * time, so there is nothing to read: the delay is chosen. Five minutes is long
 * enough that a blip has passed and short enough that a post scheduled to the
 * minute is not noticeably late, and `PUBLISH_LATE_GRACE_MS` still caps how
 * many of these a post may absorb before it is failed as missed.
 */
export const TRANSIENT_RETRY_DELAY_MS = 5 * 60 * 1000;

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

/**
 * The target as it should look at the START of a fresh attempt: hold markers
 * gone, and the previous failure's residue gone with them.
 *
 * `releaseTarget` alone is not enough here, because it clears only the hold.
 * A target that failed earlier keeps `status: 'failed'` and its old
 * `errorCode`/`errorMessage` through the release, and nothing else on the
 * publish path resets them — so a retry that is then HELD (rate limit or
 * transient failure) stores a target still reading `failed`:
 *
 *   - `targetStatusOf` answers 'failed' for the post's own status line, so
 *     the row says `scheduled` while its only target says `failed`;
 *   - `present-post` gates `heldAt`/`heldReason` on `status === 'scheduled'`,
 *     so the hold vanishes from the API and the UI cannot say "retrying";
 *   - `nothingFailed` is false, so `lastError` is written on a post that is
 *     actually waiting — the one thing the hold logic tries to avoid.
 *
 * Clearing them is also what `PostTarget.errorCode` already documents
 * ("cleared when the target is attempted again") — a promise the code did
 * not keep. This is deliberately NOT folded into `releaseTarget`, whose
 * other callers (channel resume, reconnect) release a hold WITHOUT
 * attempting anything, and must leave a previous failure intact.
 */
export function reattemptTarget<T extends PostTarget>(target: T): T {
  const released = releaseTarget(target);
  const fresh: T = released === target ? { ...target } : released;
  const loose = fresh as Partial<PostTarget> & { publishStatus?: string };

  // Both status fields, because `targetStatusOf` reads either one - clearing
  // only `status` would leave a composer-written `publishStatus: 'failed'`
  // winning, which is the same bug with a longer path to it.
  if (loose.status === 'failed') delete loose.status;
  if (loose.publishStatus === 'failed') delete loose.publishStatus;

  // The previous attempt's reason. Keeping it would caption a target that is
  // now waiting with the error that ended its LAST try.
  delete loose.errorCode;
  delete loose.errorMessage;
  return fresh;
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
