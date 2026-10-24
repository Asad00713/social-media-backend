import type { PublishedPost } from './post-performance';

/** Fewer measured posts than this and a channel has no "usual" yet. */
export const MIN_POSTS_FOR_USUAL = 5;

/** Whether the platform has reported any count for this post on this channel. */
export function isMeasured(
  p: Pick<PublishedPost, 'likes' | 'comments' | 'shares' | 'impressions'>,
): boolean {
  return (
    p.likes !== null ||
    p.comments !== null ||
    p.shares !== null ||
    p.impressions !== null
  );
}

/** Middle value; the mean of the two middle values for an even count. */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * How this post did against the channel's usual: its engagements over the
 * median of `channelEngagements`. Null with fewer than MIN_POSTS_FOR_USUAL
 * samples, or when the median is 0 (no baseline to divide by).
 */
export function usualMultiplier(
  engagements: number,
  channelEngagements: number[],
): number | null {
  if (channelEngagements.length < MIN_POSTS_FOR_USUAL) return null;
  const m = median(channelEngagements);
  if (m === null || m === 0) return null;
  return round2(engagements / m);
}
