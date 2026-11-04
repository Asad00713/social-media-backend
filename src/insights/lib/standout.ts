/**
 * Above and Below your usual (spec S3.5, S7.3): the window's posts that did
 * clearly better or worse than their channel's usual, by the post-level
 * multiplier. Pure.
 */

import type { InsightPost } from './insight-post';

/** A delta badge on a post's multiplier is "up" from here (neutral between). */
export const MULT_UP = 1.2;
/** ... and "down" from here. */
export const MULT_DOWN = 0.8;
/** A post is in the Above list from this multiplier. */
export const ABOVE_MIN = 1.5;
/** A post is in the Below list up to this multiplier. */
export const BELOW_MAX = 0.7;
/** Each list shows this many; the counts are the true totals. */
export const STANDOUT_CAP = 3;

export interface Standout {
  above: InsightPost[];
  below: InsightPost[];
  aboveCount: number;
  belowCount: number;
}

/** Tie-break: newer first, then ids, so the order never depends on input order. */
function newerFirst(a: InsightPost, b: InsightPost): number {
  return (
    Date.parse(b.publishedAt) - Date.parse(a.publishedAt) ||
    a.postId.localeCompare(b.postId) ||
    a.channelId - b.channelId
  );
}

/**
 * Above: multiplier at least ABOVE_MIN, highest first. Below: at most
 * BELOW_MAX, lowest first, never a settling post (its numbers are still
 * coming in; a settling post may be Above, since it is already above). Posts
 * without a multiplier are in neither.
 */
export function standoutOf(posts: InsightPost[]): Standout & {
  /** Every Above post, uncapped: the brief picks its drivers from all of them. */
  aboveAll: InsightPost[];
} {
  const above = posts
    .filter((p) => p.usualMultiplier !== null && p.usualMultiplier >= ABOVE_MIN)
    .sort(
      (a, b) => b.usualMultiplier! - a.usualMultiplier! || newerFirst(a, b),
    );
  const below = posts
    .filter(
      (p) =>
        p.usualMultiplier !== null &&
        p.usualMultiplier <= BELOW_MAX &&
        !p.isSettling,
    )
    .sort(
      (a, b) => a.usualMultiplier! - b.usualMultiplier! || newerFirst(a, b),
    );
  return {
    aboveAll: above,
    above: above.slice(0, STANDOUT_CAP),
    below: below.slice(0, STANDOUT_CAP),
    aboveCount: above.length,
    belowCount: below.length,
  };
}
