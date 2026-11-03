/**
 * "Your usual" at the period level (spec S3.3): what a window of N days
 * usually adds up to, from the 90 days before it. Every N-day stretch ending
 * on one of those 90 days is a sample; the usual is their median, with p25
 * and p75 as the range. Pure: callers pass day totals already built.
 */

import { isMeasured } from '../../post-performance/engagement-stats';
import { addDays, round1 } from '../../post-performance/period';
import type { PublishedPost } from '../../post-performance/post-performance';
import type { InsightsDay } from './series';

/** Stretches end on one of this many days before the window. */
export const USUAL_LOOKBACK_DAYS = 90;

/** Fewer valid stretches than this and there is no usual. */
export const MIN_USUAL_STRETCHES = 7;

/**
 * Fewer posts reporting the metric in the lookback than this and there is no
 * usual (the first-run screen's "about 10 posts").
 */
export const MIN_USUAL_POSTS = 10;

/** A delta under this many percent either way is "Usual", not up or down. */
export const FLAT_UNDER_PCT = 5;

/** Period totals; the rate's band is a rate, never divided by N. */
export interface UsualBand {
  median: number;
  p25: number;
  p75: number;
}

/** One day's total of a metric; null when nothing reported it that day. */
export interface DayTotals {
  date: string;
  value: number | null;
}

/** One day's rate parts: engagements on posts that report views, and views. */
export interface RateDay {
  date: string;
  numerator: number;
  denominator: number | null;
}

export const USUAL_METRICS = [
  'impressions',
  'reach',
  'engagements',
  'engagementRate',
  'postsPublished',
  'followersGained',
] as const;
export type UsualMetric = (typeof USUAL_METRICS)[number];
export type Usuals = Record<UsualMetric, UsualBand | null>;

/** The first day the usual reads for a window of `n` days from `from`. */
export function lookbackStartOf(from: string, n: number): string {
  return addDays(from, -(USUAL_LOOKBACK_DAYS + n - 1));
}

/** The q-th quantile of sorted values, interpolating between ranks. */
export function quantile(sorted: number[], q: number): number {
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

function bandOf(samples: number[]): UsualBand {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    median: round1(quantile(sorted, 0.5)),
    p25: round1(quantile(sorted, 0.25)),
    p75: round1(quantile(sorted, 0.75)),
  };
}

/**
 * Prefix sums over the lookback, one slot per day in date order. A day
 * missing from `days`, or with nothing reported, adds 0: inside the
 * selection's history a quiet day is a real zero. Whether the metric is
 * reported at all is the caller's `reportingPosts`.
 */
function prefixSums(
  values: Map<string, number | null>,
  start: string,
  length: number,
): number[] {
  const sums = [0];
  for (let i = 0; i < length; i++) {
    sums.push(sums[i] + (values.get(addDays(start, i)) ?? 0));
  }
  return sums;
}

/**
 * The stretches that count: each N days ending on one of the 90 days before
 * `from`, kept only when its first day is on or after the first post, so the
 * empty days before a channel's history can't drag the usual down. Each is
 * [first, last] as indexes into the lookback.
 */
function validStretches(
  n: number,
  firstPostOn: string | null,
  start: string,
): [number, number][] {
  if (firstPostOn === null) return [];
  const out: [number, number][] = [];
  for (let last = n - 1; last < USUAL_LOOKBACK_DAYS + n - 1; last++) {
    const first = last - n + 1;
    if (addDays(start, first) >= firstPostOn) out.push([first, last]);
  }
  return out;
}

/**
 * The usual N-day total of one metric before the window starting `from`.
 * `days` may cover more than the lookback (the window too); only the
 * lookback is read. Null under MIN_USUAL_STRETCHES valid stretches or
 * MIN_USUAL_POSTS posts reporting the metric in the lookback.
 */
export function periodUsual(
  days: DayTotals[],
  n: number,
  firstPostOn: string | null,
  from: string,
  reportingPosts: number,
): UsualBand | null {
  if (reportingPosts < MIN_USUAL_POSTS) return null;
  const start = lookbackStartOf(from, n);
  const stretches = validStretches(n, firstPostOn, start);
  if (stretches.length < MIN_USUAL_STRETCHES) return null;
  const sums = prefixSums(
    new Map(days.map((d) => [d.date, d.value])),
    start,
    USUAL_LOOKBACK_DAYS + n - 1,
  );
  return bandOf(stretches.map(([a, b]) => sums[b + 1] - sums[a]));
}

/**
 * The usual engagement rate (%): each stretch's rate from its own sums,
 * engagements on rated posts over views, never a mean of daily rates. A
 * stretch with no views has no rate and is left out, not counted as 0%.
 */
export function rateUsual(
  days: RateDay[],
  n: number,
  firstPostOn: string | null,
  from: string,
  reportingPosts: number,
): UsualBand | null {
  if (reportingPosts < MIN_USUAL_POSTS) return null;
  const start = lookbackStartOf(from, n);
  const length = USUAL_LOOKBACK_DAYS + n - 1;
  const num = prefixSums(
    new Map(days.map((d) => [d.date, d.numerator])),
    start,
    length,
  );
  const den = prefixSums(
    new Map(days.map((d) => [d.date, d.denominator])),
    start,
    length,
  );
  const rates: number[] = [];
  for (const [a, b] of validStretches(n, firstPostOn, start)) {
    const views = den[b + 1] - den[a];
    if (views > 0) rates.push(((num[b + 1] - num[a]) / views) * 100);
  }
  return rates.length < MIN_USUAL_STRETCHES ? null : bandOf(rates);
}

/** The earliest day any of `posts` went out; null for none. */
export function firstPostOf(posts: PublishedPost[]): string | null {
  let first: string | null = null;
  for (const p of posts) {
    if (first === null || p.publishedOn < first) first = p.publishedOn;
  }
  return first;
}

/** Whether a post reports what `metric` is made of. */
function reports(p: PublishedPost, metric: UsualMetric): boolean {
  switch (metric) {
    case 'impressions':
    case 'engagementRate':
      return p.impressions !== null;
    case 'reach':
      return p.reach !== null;
    case 'engagements':
      return isMeasured(p);
    default:
      return true;
  }
}

/**
 * One metric's usual for the window of `n` days from `from`, over `days`
 * (built from `posts`, the same selection, covering at least the lookback)
 * and `posts`. The first post is the earliest of `posts`. Followers gained
 * needs the rollup to have reported a gain somewhere in the lookback; the
 * post floor then applies to all posts.
 */
export function usualOf(
  days: InsightsDay[],
  posts: PublishedPost[],
  metric: UsualMetric,
  n: number,
  from: string,
): UsualBand | null {
  const start = lookbackStartOf(from, n);
  const before = posts.filter(
    (p) => p.publishedOn >= start && p.publishedOn < from,
  );
  const firstPostOn = firstPostOf(posts);
  if (metric === 'engagementRate') {
    return rateUsual(
      days.map((d) => ({
        date: d.date,
        numerator: d.ratedEngagements,
        denominator: d.impressions,
      })),
      n,
      firstPostOn,
      from,
      before.filter((p) => reports(p, metric)).length,
    );
  }
  let reporting = before.filter((p) => reports(p, metric)).length;
  if (
    metric === 'followersGained' &&
    !days.some(
      (d) => d.date >= start && d.date < from && d.followersGained !== null,
    )
  ) {
    reporting = 0;
  }
  return periodUsual(
    days.map((d) => ({ date: d.date, value: d[metric] })),
    n,
    firstPostOn,
    from,
    reporting,
  );
}

/** Every metric's usual, for the KPI row and the chart's band. */
export function usualsOf(
  days: InsightsDay[],
  posts: PublishedPost[],
  n: number,
  from: string,
): Usuals {
  const out = {} as Usuals;
  for (const m of USUAL_METRICS) out[m] = usualOf(days, posts, m, n, from);
  return out;
}

/** A delta badge's tone: within FLAT_UNDER_PCT either way is flat. */
export function toneOf(deltaPct: number | null): 'up' | 'flat' | 'down' | null {
  if (deltaPct === null) return null;
  if (Math.abs(deltaPct) < FLAT_UNDER_PCT) return 'flat';
  return deltaPct > 0 ? 'up' : 'down';
}
