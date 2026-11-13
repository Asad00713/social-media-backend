import type { PostStatus } from '../../drizzle/schema/posts.schema';
import { targetStatusOf, type TargetLike } from '../../posts/lib/post-status';

/**
 * What disconnecting a channel does to one post that targets it.
 *
 * Buffer deletes a disconnected channel's queued posts ("Disconnecting a
 * channel from Buffer will remove all existing posts... These cannot be
 * recovered"); Later warns they will not be published. We remove the
 * channel's UNPUBLISHED targets - scheduled, draft, failed, held by a pause -
 * so nothing fires later against a channel that is gone and the Planner shows
 * no posts for it. What already went out stays: it is on the network, and
 * other channels' history must not lose a sibling.
 *
 *   keep      nothing of this channel's to remove
 *   delete    the post was only ever this channel's work: delete the row
 *   detach    other targets remain: write `targets` and `status` back
 */
export type DisconnectPlan<T> =
  | { kind: 'keep' }
  | { kind: 'delete' }
  | { kind: 'detach'; targets: T[]; status: PostStatus };

interface DisconnectTarget extends TargetLike {
  channelId?: string | number;
  platformPostId?: string;
}

/** Published, or being published right now: never pulled out from under. */
function hasGoneOut(target: DisconnectTarget, postStatus: PostStatus): boolean {
  if (target.platformPostId) return true;
  const status = targetStatusOf(target, postStatus);
  return status === 'published' || status === 'publishing';
}

/**
 * The post status once the removed targets are gone. Only a status that was
 * derived from the targets can change: a failed or partly published post
 * whose failed part was this channel is now simply published.
 */
function statusAfter(
  postStatus: PostStatus,
  remaining: DisconnectTarget[],
): PostStatus {
  if (postStatus !== 'failed' && postStatus !== 'partially_published') {
    return postStatus;
  }
  const statuses = remaining.map((t) => targetStatusOf(t, postStatus));
  const published = statuses.filter((s) => s === 'published').length;
  if (published === 0) return 'failed';
  return published === remaining.length ? 'published' : 'partially_published';
}

export function planDisconnect<T extends DisconnectTarget>(
  postStatus: PostStatus,
  targets: T[],
  channelId: string,
): DisconnectPlan<T> {
  // A publish job is working on this post now; rewriting its targets would
  // race the publisher's own write. Its target for this channel fails
  // ("channel not found") instead - rare, and visible.
  if (postStatus === 'publishing') return { kind: 'keep' };

  const isRemoved = (t: T) =>
    String(t.channelId) === channelId && !hasGoneOut(t, postStatus);
  const remaining = targets.filter((t) => !isRemoved(t));

  if (remaining.length === targets.length) return { kind: 'keep' };
  if (remaining.length === 0) return { kind: 'delete' };
  return {
    kind: 'detach',
    targets: remaining,
    status: statusAfter(postStatus, remaining),
  };
}
