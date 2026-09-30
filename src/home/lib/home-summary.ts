/**
 * Pure aggregation for the Home summary. No I/O: the service fetches rows,
 * these functions turn them into numbers, so every rule here is unit-tested.
 *
 * Post numbers come from `PublishedPost`s (see post-performance). Follower
 * numbers come from the daily rollup, whose follower columns, unlike its
 * engagement ones, are genuinely per day.
 */
import {
  engagementsOf,
  type PublishedPost,
} from '../../post-performance/post-performance';

/** A channel's followers on one day, from the daily rollup. */
export interface FollowerRow {
  channelId: number;
  /** `YYYY-MM-DD`, one row per channel per day. */
  date: string;
  followersAtEndOfDay: number | null;
  followersGained: number | null;
}

export interface ChannelSummary {
  channelId: number;
  followers: number | null;
  followersGained: number | null;
  growthPct: number | null;
  postsThisWeek: number;
}

/** The windows Home's Performance can show. */
export const PULSE_RANGES = [7, 30, 90] as const;
export type PulseRange = (typeof PULSE_RANGES)[number];

/** One day of the workspace, summed across channels — a sparkline point. */
export interface PulseDay {
  /** `YYYY-MM-DD`. */
  date: string;
  postsPublished: number;
  /** null when no channel reported impressions that day. */
  impressions: number | null;
  engagements: number;
  /** null when no channel reported follower changes that day. */
  followersGained: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/** How far back a streak is counted. Long enough for any realistic streak. */
export const STREAK_LOOKBACK_WEEKS = 52;

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Percentage change, one decimal. Null when either side is unknown or the base is 0. */
export function deltaPct(
  current: number | null,
  previous: number | null,
): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return round1(((current - previous) / previous) * 100);
}

/** Follower gains summed across rows; null when no channel reported a change. */
export function followersGainedOf(rows: FollowerRow[]): number | null {
  let gained: number | null = null;
  for (const r of rows) {
    if (r.followersGained !== null) gained = (gained ?? 0) + r.followersGained;
  }
  return gained;
}

/**
 * One channel over the window: its latest known follower count, the gain
 * across the window, growth relative to where the window started, and how
 * many posts it published.
 */
export function summarizeChannel(
  channelId: number,
  rows: FollowerRow[],
  postsThisWeek: number,
): ChannelSummary {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  let followers: number | null = null;
  for (const r of sorted) {
    if (r.followersAtEndOfDay !== null) followers = r.followersAtEndOfDay;
  }
  const followersGained = followersGainedOf(rows);

  const startingFollowers =
    followers !== null && followersGained !== null
      ? followers - followersGained
      : null;
  const growthPct =
    startingFollowers && startingFollowers > 0 && followersGained !== null
      ? round1((followersGained / startingFollowers) * 100)
      : null;

  return { channelId, followers, followersGained, growthPct, postsThisWeek };
}

/** Monday 00:00 UTC of the week containing `d`. */
export function weekStart(d: Date): Date {
  const day = d.getUTCDay(); // 0 = Sunday
  const back = (day + 6) % 7;
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back),
  );
}

/**
 * Consecutive weeks (Monday-based, UTC) with at least one published post.
 * This week counts if it already has a post; if it doesn't yet, the streak is
 * still alive from last week — the week isn't over.
 */
export function computeStreakWeeks(publishedAt: Date[], now: Date): number {
  const weeks = new Set(publishedAt.map((d) => weekStart(d).getTime()));
  let cursor = weekStart(now).getTime();
  if (!weeks.has(cursor)) cursor -= WEEK_MS;

  let streak = 0;
  while (weeks.has(cursor) && streak < STREAK_LOOKBACK_WEEKS) {
    streak += 1;
    cursor -= WEEK_MS;
  }
  return streak;
}

export function isPulseRange(days: number): days is PulseRange {
  return (PULSE_RANGES as readonly number[]).includes(days);
}

/**
 * Every day from `from` to `to` (inclusive, `YYYY-MM-DD`), summed across
 * channels: each post on the day it went out, with its latest numbers. Days
 * with nothing still appear, at zero, so a sparkline's x-axis is time rather
 * than "days we happened to have data".
 */
export function dailySeries(
  posts: PublishedPost[],
  followers: FollowerRow[],
  from: string,
  to: string,
): PulseDay[] {
  const byDate = new Map<string, PulseDay>();
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += DAY_MS) {
    const date = new Date(t).toISOString().slice(0, 10);
    byDate.set(date, {
      date,
      postsPublished: 0,
      impressions: null,
      engagements: 0,
      followersGained: null,
    });
  }

  for (const p of posts) {
    const day = byDate.get(p.publishedOn);
    if (!day) continue;
    day.postsPublished += 1;
    day.engagements += engagementsOf(p);
    if (p.impressions !== null)
      day.impressions = (day.impressions ?? 0) + p.impressions;
  }
  for (const r of followers) {
    const day = byDate.get(r.date);
    if (!day || r.followersGained === null) continue;
    day.followersGained = (day.followersGained ?? 0) + r.followersGained;
  }
  return [...byDate.values()];
}
