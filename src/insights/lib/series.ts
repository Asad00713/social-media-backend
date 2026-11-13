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
  /** null when no post that day reported reach. */
  reach: number | null;
  /** likes + comments + shares: the three below, added up. */
  engagements: number;
  /** The day's posts' likes (reactions); 0 when none reported any. */
  likes: number;
  comments: number;
  shares: number;
  /**
   * Engagements on posts that report impressions: the rate's numerator. Kept
   * apart so a week's rate is recomputed from sums, never averaged from days.
   */
  ratedEngagements: number;
  /** Total followers at the end of the day, carried forward; null if unknown. */
  followers: number | null;
  /**
   * Net new followers that day from the rollup, summed over channels; null
   * when no channel reported a change that day (never carried).
   */
  followersGained: number | null;
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
      reach: null,
      engagements: 0,
      likes: 0,
      comments: 0,
      shares: 0,
      ratedEngagements: 0,
      followers: totals.get(date) ?? null,
      followersGained: null,
    });
  }

  for (const r of followers) {
    const day = days.get(r.date);
    if (!day || r.followersGained === null) continue;
    day.followersGained = (day.followersGained ?? 0) + r.followersGained;
  }

  for (const p of posts) {
    const day = days.get(p.publishedOn);
    if (!day) continue;
    const e = engagementsOf(p);
    day.postsPublished += 1;
    day.engagements += e;
    day.likes += p.likes ?? 0;
    day.comments += p.comments ?? 0;
    day.shares += p.shares ?? 0;
    if (p.impressions !== null) {
      day.impressions = (day.impressions ?? 0) + p.impressions;
      day.ratedEngagements += e;
    }
    if (p.reach !== null) day.reach = (day.reach ?? 0) + p.reach;
  }
  return [...days.values()];
}

/** A span's totals, added up from its days. */
export interface RangeTotals {
  postsPublished: number;
  impressions: number | null;
  reach: number | null;
  engagements: number;
  /** Rated engagements ÷ impressions × 100, one decimal, from the sums. */
  engagementRate: number | null;
  followersGained: number | null;
}

/** The same totals as `totalsOf`, plus reach and gains, from day rows. */
export function rangeTotals(days: InsightsDay[]): RangeTotals {
  const add = (a: number | null, b: number | null): number | null =>
    b === null ? a : (a ?? 0) + b;
  let impressions: number | null = null;
  let reach: number | null = null;
  let followersGained: number | null = null;
  let postsPublished = 0;
  let engagements = 0;
  let rated = 0;
  for (const d of days) {
    postsPublished += d.postsPublished;
    engagements += d.engagements;
    rated += d.ratedEngagements;
    impressions = add(impressions, d.impressions);
    reach = add(reach, d.reach);
    followersGained = add(followersGained, d.followersGained);
  }
  return {
    postsPublished,
    impressions,
    reach,
    engagements,
    engagementRate: impressions ? round1((rated / impressions) * 100) : null,
    followersGained,
  };
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
