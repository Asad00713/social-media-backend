import { datesBetween } from './period';

/**
 * A channel's followers on one day, from the daily rollup. Unlike its
 * engagement columns, its follower columns are genuinely per day.
 */
export interface FollowerRow {
  channelId: number;
  /** `YYYY-MM-DD`, one row per channel per day. */
  date: string;
  followersAtEndOfDay: number | null;
  followersGained: number | null;
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
 * Total followers at the end of each day from `from` to `to`. Each channel's
 * last known count is carried over days the rollup missed, and rows before
 * `from` seed the carry. The value is null on a day before any channel had
 * reported.
 */
export function followersByDay(
  rows: FollowerRow[],
  from: string,
  to: string,
): Map<string, number | null> {
  const sorted = rows
    .filter((r) => r.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date));
  const latest = new Map<number, number>();
  const totals = new Map<string, number | null>();
  let i = 0;

  for (const date of datesBetween(from, to)) {
    while (i < sorted.length && sorted[i].date <= date) {
      const r = sorted[i++];
      if (r.followersAtEndOfDay !== null) {
        latest.set(r.channelId, r.followersAtEndOfDay);
      }
    }
    totals.set(
      date,
      latest.size ? [...latest.values()].reduce((a, b) => a + b, 0) : null,
    );
  }
  return totals;
}
