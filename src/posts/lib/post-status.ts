import type { PostStatus } from '../../drizzle/schema/posts.schema';

/**
 * A post target carries two status fields (`status` and the composer's
 * `publishStatus`). Never read only one.
 */
export interface TargetLike {
  status?: string;
  publishStatus?: string;
}

const either = (t: TargetLike, ...values: string[]): boolean =>
  values.some((v) => t.status === v || t.publishStatus === v);

export function targetStatusOf(
  target: TargetLike,
  postStatus: PostStatus,
): PostStatus {
  if (either(target, 'published')) return 'published';
  if (either(target, 'failed')) return 'failed';
  if (
    either(target, 'publishing', 'retry_pending') ||
    postStatus === 'publishing'
  ) {
    return 'publishing';
  }
  return postStatus === 'scheduled' ? 'scheduled' : 'draft';
}

export function derivePostStatus(
  postStatus: PostStatus,
  targets: TargetLike[],
): PostStatus {
  if (postStatus === 'partially_published') return postStatus;
  if (postStatus !== 'published' && postStatus !== 'failed') return postStatus;
  const statuses = targets.map((t) => targetStatusOf(t, postStatus));
  const hasPublished = statuses.includes('published');
  const hasFailed = statuses.includes('failed');
  return hasPublished && hasFailed ? 'partially_published' : postStatus;
}

/**
 * How many of a post's targets are live on their platform, whatever the
 * stored post status says. Used by the guards that must never orphan a
 * published post (delete, move to drafts).
 */
export function publishedTargetState(
  targets: TargetLike[],
): 'none' | 'some' | 'all' {
  const published = targets.filter((t) => either(t, 'published')).length;
  if (published === 0) return 'none';
  return published === targets.length ? 'all' : 'some';
}
