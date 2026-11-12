import type { RawSlice } from '../../drizzle/schema/channel-audience.schema';
import type { DemographicsRow } from '../../channels/analytics/adapters/youtube/youtube-analytics-api.client';
import type { AudienceSlice, AudienceStatus } from './audience.dto';

export type AudienceKind = 'countries' | 'cities' | 'ages' | 'genders';

const TOP_COUNTRIES = 5;
const TOP_CITIES = 4;

const AGE_BUCKETS = ['13-17', '18-24', '25-34', '35-44', '45-54', '55+'];
const GENDERS = ['female', 'male', 'unknown'];

/**
 * Canonical age bucket for any platform spelling, or null when unknown.
 * Meta: `13-17`, `55-64`, `65+`. YouTube: `age13-17`, `age55-64`, `age65-`.
 * An already-canonical key (`55+`) maps to itself.
 */
function ageBucket(raw: string): string | null {
  const key = raw.startsWith('age') ? raw.slice(3) : raw;
  switch (key) {
    case '13-17':
    case '18-24':
    case '25-34':
    case '35-44':
    case '45-54':
      return key;
    case '55-64':
    case '65+':
    case '65-':
    case '55+':
      return '55+';
    default:
      return null;
  }
}

/** Canonical gender for Meta (F/M/U), YouTube (user_specified) or canonical keys. */
function genderKey(raw: string): string | null {
  switch (raw) {
    case 'F':
    case 'female':
      return 'female';
    case 'M':
    case 'male':
      return 'male';
    case 'U':
    case 'user_specified':
    case 'unknown':
      return 'unknown';
    default:
      return null;
  }
}

/** Sum values per key, in first-seen order. */
function sumByKey(entries: Array<[string, number]>): RawSlice[] {
  const sums = new Map<string, number>();
  for (const [key, value] of entries) {
    sums.set(key, (sums.get(key) ?? 0) + value);
  }
  return [...sums].map(([key, value]) => ({ key, value }));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Meta `follower_demographics` (Instagram and Threads):
 * data[0].total_value.breakdowns[0].results[].{ dimension_values[0], value }.
 * Anything missing or malformed yields [] (a new or small account is `ok`
 * with no data, not an error). Keys are normalised for the breakdown: cities
 * lose their region, ages merge into the display buckets, genders spell out.
 */
export function metaBreakdown(
  body: unknown,
  breakdown: 'country' | 'city' | 'age' | 'gender',
): RawSlice[] {
  if (!isRecord(body) || !Array.isArray(body.data)) return [];
  const metric: unknown = body.data[0];
  if (!isRecord(metric) || !isRecord(metric.total_value)) return [];
  const breakdowns = metric.total_value.breakdowns;
  if (!Array.isArray(breakdowns)) return [];
  const first: unknown = breakdowns[0];
  if (!isRecord(first) || !Array.isArray(first.results)) return [];

  const entries: Array<[string, number]> = [];
  for (const result of first.results as unknown[]) {
    if (!isRecord(result) || !Array.isArray(result.dimension_values)) continue;
    const dim: unknown = result.dimension_values[0];
    if (typeof dim !== 'string' || dim === '' || !isCount(result.value)) {
      continue;
    }
    let key: string | null;
    if (breakdown === 'city') key = dim.split(',')[0].trim() || null;
    else if (breakdown === 'age') key = ageBucket(dim);
    else if (breakdown === 'gender') key = genderKey(dim);
    else key = dim;
    if (key !== null) entries.push([key, result.value]);
  }
  return sumByKey(entries);
}

/**
 * Facebook Page `page_follows_country` / `page_follows_city`: the newest
 * `values[]` entry holds a `{ key: count }` map. "Newest" is the greatest
 * `end_time`, falling back to the last entry when no entry has one.
 */
export function facebookLocation(body: unknown): RawSlice[] {
  if (!isRecord(body) || !Array.isArray(body.data)) return [];
  const metric: unknown = body.data[0];
  if (!isRecord(metric) || !Array.isArray(metric.values)) return [];

  let newest: Record<string, unknown> | null = null;
  let newestTime = Number.NEGATIVE_INFINITY;
  for (const entry of metric.values as unknown[]) {
    if (!isRecord(entry)) continue;
    const time =
      typeof entry.end_time === 'string' ? Date.parse(entry.end_time) : NaN;
    if (Number.isNaN(time)) {
      // No usable timestamp: only wins while nothing is dated, last one wins.
      if (newestTime === Number.NEGATIVE_INFINITY) newest = entry;
    } else if (time >= newestTime) {
      newest = entry;
      newestTime = time;
    }
  }
  if (!newest || !isRecord(newest.value)) return [];

  const entries: Array<[string, number]> = [];
  for (const [key, count] of Object.entries(newest.value)) {
    if (isCount(count)) entries.push([key, count]);
  }
  return sumByKey(entries);
}

/** YouTube `viewerPercentage` summed across gender, per canonical age bucket. */
export function youtubeAges(rows: DemographicsRow[]): RawSlice[] {
  const entries: Array<[string, number]> = [];
  for (const row of rows) {
    const key = ageBucket(row.ageGroup);
    if (key !== null && isCount(row.viewerPercentage)) {
      entries.push([key, row.viewerPercentage]);
    }
  }
  return sumByKey(entries);
}

/** YouTube `viewerPercentage` summed across age, per canonical gender. */
export function youtubeGenders(rows: DemographicsRow[]): RawSlice[] {
  const entries: Array<[string, number]> = [];
  for (const row of rows) {
    const key = genderKey(row.gender);
    if (key !== null && isCount(row.viewerPercentage)) {
      entries.push([key, row.viewerPercentage]);
    }
  }
  return sumByKey(entries);
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Raw counts to display shares. Percent = value / sum of ALL values x 100,
 * computed before any top-N cut. With `alreadyPercent` (YouTube) the values
 * are percentages already: they are only rounded. Countries and cities are
 * sorted by value and cut to the top 5 / 4; ages and genders come in their
 * fixed order with missing buckets at 0. No data at all gives [] (an `ok`
 * row with empty arrays), not six zero buckets.
 */
export function toShares(
  raw: RawSlice[],
  kind: AudienceKind,
  alreadyPercent = false,
): AudienceSlice[] {
  if (raw.length === 0) return [];

  let slices: RawSlice[];
  if (kind === 'ages' || kind === 'genders') {
    const canon = kind === 'ages' ? ageBucket : genderKey;
    const order = kind === 'ages' ? AGE_BUCKETS : GENDERS;
    const sums = new Map<string, number>(order.map((k) => [k, 0]));
    for (const { key, value } of raw) {
      const bucket = canon(key);
      if (bucket !== null) sums.set(bucket, (sums.get(bucket) ?? 0) + value);
    }
    slices = order.map((key) => ({ key, value: sums.get(key) ?? 0 }));
  } else {
    // Equal values tie-break on key so the cut is deterministic.
    slices = [...raw].sort(
      (a, b) => b.value - a.value || a.key.localeCompare(b.key),
    );
  }

  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const percentOf = (value: number): number => {
    if (alreadyPercent) return round1(value);
    return total > 0 ? round1((value / total) * 100) : 0;
  };

  if (kind === 'countries') slices = slices.slice(0, TOP_COUNTRIES);
  if (kind === 'cities') slices = slices.slice(0, TOP_CITIES);

  return slices.map(({ key, value }) => ({ key, percent: percentOf(value) }));
}

/**
 * Meta error code 10 or 200-299 means the channel lacks a permission; every
 * other failure (auth, rate, transient, permanent) is `failed`. Duck-typed on
 * `metaCode` so it works for all the Meta client error classes.
 */
export function statusOfError(
  err: unknown,
): Extract<AudienceStatus, 'no_permission' | 'failed'> {
  const code = (err as { metaCode?: unknown } | null | undefined)?.metaCode;
  if (
    typeof code === 'number' &&
    (code === 10 || (code >= 200 && code <= 299))
  ) {
    return 'no_permission';
  }
  return 'failed';
}
