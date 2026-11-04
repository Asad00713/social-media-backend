import {
  median,
  MIN_POSTS_FOR_USUAL,
} from '../../post-performance/engagement-stats';
import { reportsOf } from './freshness';

/** Hours after publishing the "First 48 hours" chart reads. */
export const TIMELINE_HOURS = [
  0, 1, 2, 3, 4, 6, 8, 12, 16, 20, 24, 30, 36, 42, 48,
] as const;
/** The span of the chart, and how far snapshots are read. */
export const TIMELINE_SPAN_HOURS = 48;
/** A first snapshot later than this leaves the early curve unknown. */
export const EARLY_SNAPSHOT_HOURS = 6;
/** Fewer snapshots than this cannot make a curve. */
export const MIN_TIMELINE_POINTS = 3;

const HOUR_MS = 3_600_000;

export type TimelineMetric = 'reach' | 'impressions' | 'engagements';
export type TimelineStatus = 'ok' | 'collecting' | 'no_early_data';

/** One snapshot within the first 48 hours (a `snapshotsWithin` row, camelCased). */
export interface TimelineSnap {
  snapshotAt: Date | string;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  impressions: number | null;
  reach: number | null;
}

/**
 * The curve's metric: reach where the platform shares it, else views, else
 * engagements (every platform has those).
 */
export function timelineMetricOf(platform: string): TimelineMetric {
  const r = reportsOf(platform);
  if (r.reportsReach) return 'reach';
  if (r.reportsViews) return 'impressions';
  return 'engagements';
}

const at = (s: TimelineSnap): number => new Date(s.snapshotAt).getTime();

function valueOf(s: TimelineSnap, metric: TimelineMetric): number | null {
  if (metric === 'reach') return s.reach;
  if (metric === 'impressions') return s.impressions;
  if (s.likes === null && s.comments === null && s.shares === null) {
    return null;
  }
  return (s.likes ?? 0) + (s.comments ?? 0) + (s.shares ?? 0);
}

/**
 * The metric at each of TIMELINE_HOURS after `publishedAt`: the newest
 * snapshot at or before that hour, carried forward until the next one, so the
 * line never falls back to nothing. Hour 0 is 0 and a snapshot that doesn't
 * report the metric leaves the last value standing. Hours after `now` are
 * null: the line stops where the post's life does.
 */
export function timelineValues(
  snaps: TimelineSnap[],
  publishedAt: Date | string,
  metric: TimelineMetric,
  now: Date,
): (number | null)[] {
  const start = new Date(publishedAt).getTime();
  const sorted = [...snaps].sort((a, b) => at(a) - at(b));
  let i = 0;
  let last = 0;
  return TIMELINE_HOURS.map((h) => {
    const t = start + h * HOUR_MS;
    if (t > now.getTime()) return null;
    if (h === 0) return 0;
    while (i < sorted.length && at(sorted[i]) <= t) {
      const v = valueOf(sorted[i], metric);
      if (v !== null) last = v;
      i += 1;
    }
    return last;
  });
}

/**
 * `no_early_data`: nothing to draw, because the first snapshot came more than
 * 6 hours after publishing (an imported post) or there are under 3. Otherwise
 * `collecting` until the post is 48 hours old, then `ok`.
 */
export function timelineStatus(
  snaps: TimelineSnap[],
  publishedAt: Date | string,
  now: Date,
): TimelineStatus {
  const start = new Date(publishedAt).getTime();
  if (snaps.length < MIN_TIMELINE_POINTS) return 'no_early_data';
  const first = Math.min(...snaps.map(at));
  if (first - start > EARLY_SNAPSHOT_HOURS * HOUR_MS) return 'no_early_data';
  return now.getTime() < start + TIMELINE_SPAN_HOURS * HOUR_MS
    ? 'collecting'
    : 'ok';
}

/**
 * The usual post's curve: at each hour the median over the posts that have a
 * value there. Null under MIN_POSTS_FOR_USUAL posts; an hour with fewer than
 * that many values is null too, so a few young posts can't stand for "usual".
 */
export function usualCurve(
  perPost: (number | null)[][],
): (number | null)[] | null {
  if (perPost.length < MIN_POSTS_FOR_USUAL) return null;
  return TIMELINE_HOURS.map((_, i) => {
    const vs = perPost.flatMap((p) => (p[i] == null ? [] : [p[i] as number]));
    return vs.length >= MIN_POSTS_FOR_USUAL ? median(vs) : null;
  });
}
