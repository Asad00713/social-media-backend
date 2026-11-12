import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { posts, type PostTarget } from '../../drizzle/schema/posts.schema';

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
}

export function isHeld(target: Pick<PostTarget, 'heldAt'>): boolean {
  return typeof target.heldAt === 'string' && target.heldAt !== '';
}

/** The target, held. Its status fields are deliberately not touched. */
export function holdTarget<T extends PostTarget>(target: T, now: Date): T {
  return {
    ...target,
    heldAt: isHeld(target) ? target.heldAt : now.toISOString(),
    heldReason: HELD_REASON,
  };
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
): Promise<string> {
  const jobId = `post-${post.id}-resume-${now.getTime()}`;
  const data: PublishJobData = { postId: post.id, heldOnly: true };
  const job = await queue.add('publish-post', data, {
    delay: resumeDelayMs(post.scheduledAt, now),
    jobId,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  });
  const id = (job.id as string) ?? jobId;
  await db.update(posts).set({ jobId: id }).where(eq(posts.id, post.id));
  return id;
}
