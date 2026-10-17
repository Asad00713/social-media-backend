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
