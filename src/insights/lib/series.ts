import {
  followersByDay,
  followersGainedOf,
  type FollowerRow,
} from '../../post-performance/followers';
import {
  datesBetween,
  round1,
  type PeriodWindow,
} from '../../post-performance/period';
import {
  engagementsOf,
  type PublishedPost,
} from '../../post-performance/post-performance';

export interface InsightsDay {
  date: string;
  postsPublished: number;
  /** null when no post that day reported impressions. */
  impressions: number | null;
  engagements: number;
  /**
   * Engagements on posts that report impressions: the rate's numerator. Kept
   * apart so a week's rate is recomputed from sums, never averaged from days.
   */
  ratedEngagements: number;
  /** Total followers at the end of the day, carried forward; null if unknown. */
  followers: number | null;
}

/** Every day from `from` to `to`: each post on the day it went out. */
export function daySeries(
  posts: PublishedPost[],
  followers: FollowerRow[],
  from: string,
  to: string,
): InsightsDay[] {
  const totals = followersByDay(followers, from, to);
  const days = new Map<string, InsightsDay>();
  for (const date of datesBetween(from, to)) {
    days.set(date, {
      date,
      postsPublished: 0,
      impressions: null,
      engagements: 0,
      ratedEngagements: 0,
      followers: totals.get(date) ?? null,
    });
  }

  for (const p of posts) {
    const day = days.get(p.publishedOn);
    if (!day) continue;
    const e = engagementsOf(p);
    day.postsPublished += 1;
    day.engagements += e;
    if (p.impressions !== null) {
      day.impressions = (day.impressions ?? 0) + p.impressions;
      day.ratedEngagements += e;
    }
  }
  return [...days.values()];
}

export interface FollowerTotals {
  /** Followers at the end of the window. */
  value: number | null;
  /** Net new followers in the window. */
  gained: number | null;
  /** gained ÷ followers at the start × 100, one decimal. */
  growthPct: number | null;
  previousGained: number | null;
}

export function followerTotals(
  rows: FollowerRow[],
  window: PeriodWindow,
): FollowerTotals {
  const value =
    followersByDay(rows, window.to, window.to).get(window.to) ?? null;
  const gained = followersGainedOf(
    rows.filter((r) => r.date >= window.from && r.date <= window.to),
  );
  const start = value !== null && gained !== null ? value - gained : null;
  return {
    value,
    gained,
    growthPct:
      start !== null && start > 0 && gained !== null
        ? round1((gained / start) * 100)
        : null,
    previousGained: followersGainedOf(
      rows.filter(
        (r) => r.date >= window.previousFrom && r.date <= window.previousTo,
      ),
    ),
  };
}
