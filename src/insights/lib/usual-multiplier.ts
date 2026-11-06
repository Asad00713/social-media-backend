import {
  isMeasured,
  usualMultiplier,
} from '../../post-performance/engagement-stats';
import {
  engagementsOf,
  type PublishedPost,
} from '../../post-performance/post-performance';

/**
 * Each channel's measured engagements in `sample` (the last 90 days): what a
 * post's "usual" is the median of. Unmeasured posts are left out, so a post
 * the platform hasn't reported yet can't drag the usual down to 0.
 */
export function usualByChannel(sample: PublishedPost[]): Map<number, number[]> {
  const usual = new Map<number, number[]>();
  for (const p of sample) {
    if (!isMeasured(p)) continue;
    const list = usual.get(p.channelId) ?? [];
    list.push(engagementsOf(p));
    usual.set(p.channelId, list);
  }
  return usual;
}

/**
 * The post's engagements over its channel's usual. Null when the post isn't
 * measured (no data is not "0× the usual"), and under the floor or a 0 median
 * as `usualMultiplier` says.
 */
export function multiplierOf(
  p: PublishedPost,
  usual: Map<number, number[]>,
): number | null {
  if (!isMeasured(p)) return null;
  return usualMultiplier(engagementsOf(p), usual.get(p.channelId) ?? []);
}
