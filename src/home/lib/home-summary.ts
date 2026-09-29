/**
 * Pure aggregation for the Home summary. No I/O: the service fetches rows,
 * these functions turn them into numbers, so every rule here is unit-tested.
 */

export interface DailyRow {
  channelId: number;
  /** `YYYY-MM-DD`, one row per channel per day. */
  date: string;
  postsPublished: number;
  totalLikes: number;
  totalComments: number;
  totalShares: number;
  totalImpressions: number | null;
  followersAtEndOfDay: number | null;
  followersGained: number | null;
}

export interface WindowSummary {
  postsPublished: number;
  /** null when no channel reported impressions for the window. */
  impressions: number | null;
  engagements: number;
  /** engagements / impressions × 100, one decimal; null without impressions. */
  engagementRate: number | null;
  /** null when no channel reported follower changes for the window. */
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

/** Sums a window of daily rows across every channel. */
export function summarizeWindow(rows: DailyRow[]): WindowSummary {
  let postsPublished = 0;
  let engagements = 0;
  let impressions: number | null = null;
  let followersGained: number | null = null;

  for (const r of rows) {
    postsPublished += r.postsPublished;
    engagements += r.totalLikes + r.totalComments + r.totalShares;
    if (r.totalImpressions !== null)
      impressions = (impressions ?? 0) + r.totalImpressions;
    if (r.followersGained !== null)
      followersGained = (followersGained ?? 0) + r.followersGained;
  }

  return {
    postsPublished,
    impressions,
    engagements,
    engagementRate: impressions
      ? round1((engagements / impressions) * 100)
      : null,
    followersGained,
  };
}

/**
 * One channel over the window: its latest known follower count, the gain
 * across the window, and growth relative to where the window started.
 */
export function summarizeChannel(
  channelId: number,
  rows: DailyRow[],
): ChannelSummary {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  let followers: number | null = null;
  let followersGained: number | null = null;
  let postsThisWeek = 0;

  for (const r of sorted) {
    if (r.followersAtEndOfDay !== null) followers = r.followersAtEndOfDay;
    if (r.followersGained !== null)
      followersGained = (followersGained ?? 0) + r.followersGained;
    postsThisWeek += r.postsPublished;
  }

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
 * channels. Days without a row still appear, at zero, so a sparkline's x-axis
 * is time rather than "days we happened to have data".
 */
export function dailySeries(
  rows: DailyRow[],
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

  for (const r of rows) {
    const day = byDate.get(r.date);
    if (!day) continue;
    day.postsPublished += r.postsPublished;
    day.engagements += r.totalLikes + r.totalComments + r.totalShares;
    if (r.totalImpressions !== null)
      day.impressions = (day.impressions ?? 0) + r.totalImpressions;
    if (r.followersGained !== null)
      day.followersGained = (day.followersGained ?? 0) + r.followersGained;
  }
  return [...byDate.values()];
}
