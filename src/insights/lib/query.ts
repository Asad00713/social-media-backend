import { BadRequestException } from '@nestjs/common';
import {
  DAY_MS,
  PERIOD_DAYS,
  customWindow,
  isPeriodDays,
  isoDate,
  windowOf,
  yearBefore,
  type PeriodDays,
  type PeriodWindow,
} from '../../post-performance/period';
import { POST_FORMATS, type PostFormat } from './insight-post';

export function parseDays(raw?: string): PeriodDays {
  if (raw === undefined || raw === '') return 30;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!isPeriodDays(n)) {
    throw new BadRequestException(
      `days must be one of ${PERIOD_DAYS.join(', ')}`,
    );
  }
  return n;
}

/**
 * The longest picked range. It also bounds the usual's lookback (90 days
 * before the window plus the window) at 179 days.
 */
export const MAX_CUSTOM_DAYS = 90;

/** The window asked for: a preset or a picked range, with its length. */
export interface ResolvedPeriod {
  /** Days in the window: 7, 30 or 90 for a preset, 1 to 90 when picked. */
  days: number;
  window: PeriodWindow;
}

const absent = (s?: string): boolean => s === undefined || s === '';

/** A real calendar date, `YYYY-MM-DD`; it must survive a trip through Date.UTC. */
function parseIsoDate(raw: string, name: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const t = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  if (Number.isNaN(t) || isoDate(new Date(t)) !== raw) {
    throw new BadRequestException(`${name} must be a date, YYYY-MM-DD`);
  }
  return t;
}

/**
 * `days=7|30|90` or `from=YYYY-MM-DD&to=YYYY-MM-DD`, never both. A picked
 * range is whole UTC days, ends yesterday at the latest (today is still being
 * measured) and spans 1 to MAX_CUSTOM_DAYS days. With neither, 30 days.
 * `today` is midnight UTC (`utcToday`).
 */
export function parsePeriod(
  raw: { days?: string; from?: string; to?: string },
  today: Date,
): ResolvedPeriod {
  if (absent(raw.from) && absent(raw.to)) {
    const days = parseDays(raw.days);
    return { days, window: windowOf(today, days) };
  }
  if (!absent(raw.days)) {
    throw new BadRequestException('Send days or from and to, not both');
  }
  if (absent(raw.from) || absent(raw.to)) {
    throw new BadRequestException('from and to go together');
  }
  const from = raw.from as string;
  const to = raw.to as string;
  const start = parseIsoDate(from, 'from');
  const end = parseIsoDate(to, 'to');
  if (start > end) {
    throw new BadRequestException('from must be on or before to');
  }
  if (end > today.getTime() - DAY_MS) {
    throw new BadRequestException('to must be yesterday or earlier');
  }
  const days = (end - start) / DAY_MS + 1;
  if (days > MAX_CUSTOM_DAYS) {
    throw new BadRequestException(
      `A range can be at most ${MAX_CUSTOM_DAYS} days`,
    );
  }
  return { days, window: customWindow(from, to) };
}

export const COMPARE_MODES = ['usual', 'previous', 'year', 'none'] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];

/** `compare=`, your usual by default. */
export function parseCompare(raw?: string): CompareMode {
  return oneOf(raw, COMPARE_MODES, 'usual', 'compare');
}

/**
 * The dates a comparison reads: the span just before, or the same dates a
 * year back (Feb 29 as Feb 28). Null for `usual`, which is a 90-day median
 * rather than a date range, and for `none`.
 */
export function comparisonRange(
  window: PeriodWindow,
  mode: CompareMode,
): { from: string; to: string } | null {
  if (mode === 'previous') {
    return { from: window.previousFrom, to: window.previousTo };
  }
  if (mode === 'year') {
    return { from: yearBefore(window.from), to: yearBefore(window.to) };
  }
  return null;
}

/**
 * A query param that must come once. Repeated (`?channels=1&channels=2`)
 * Express hands over an array, which would otherwise crash the parser as a
 * 500; it is a bad request.
 */
export function single(
  raw: string | string[] | undefined,
  name: string,
): string | undefined {
  if (Array.isArray(raw)) {
    throw new BadRequestException(`Send ${name} once`);
  }
  return raw;
}

/**
 * The asked-for channels narrowed to `allowed`: the workspace's social
 * channels, paused ones included. Ids outside it are dropped, never queried.
 * A stale id left by a disconnect shouldn't break the page, and dropping says
 * nothing about other workspaces. With no `channels` param, every allowed
 * channel counts.
 */
export function parseChannels(
  raw: string | undefined,
  allowed: number[],
): number[] {
  if (raw === undefined || raw.trim() === '') return allowed;
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.some((s) => !/^\d+$/.test(s))) {
    throw new BadRequestException('channels must be comma-separated ids');
  }
  const wanted = new Set(parts.map(Number));
  return allowed.filter((id) => wanted.has(id));
}

export function parseTz(raw?: string): string {
  if (raw === undefined || raw === '') return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw });
    return raw;
  } catch {
    throw new BadRequestException('tz must be an IANA time zone');
  }
}

/** `usual` sorts by the post's multiplier over its channel's usual. */
export const SORT_KEYS = [
  'publishedAt',
  'impressions',
  'reach',
  'engagements',
  'engagementRate',
  'likes',
  'comments',
  'shares',
  'usual',
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export interface TableQuery {
  format: PostFormat | 'all';
  sort: SortKey;
  order: 'asc' | 'desc';
  limit: number;
  offset: number;
}

function oneOf<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
  name: string,
): T {
  if (raw === undefined || raw === '') return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new BadRequestException(
      `${name} must be one of ${allowed.join(', ')}`,
    );
  }
  return raw as T;
}

function intIn(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (raw === undefined || raw === '') return fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new BadRequestException(
      `${name} must be a whole number from ${min} to ${max}`,
    );
  }
  return n;
}

export function parseTableQuery(raw: {
  format?: string;
  sort?: string;
  order?: string;
  limit?: string;
  offset?: string;
}): TableQuery {
  return {
    format: oneOf(
      raw.format,
      ['all', ...POST_FORMATS] as const,
      'all',
      'format',
    ),
    sort: oneOf(raw.sort, SORT_KEYS, 'publishedAt', 'sort'),
    order: oneOf(raw.order, ['desc', 'asc'] as const, 'desc', 'order'),
    limit: intIn(raw.limit, 10, 1, 100, 'limit'),
    offset: intIn(raw.offset, 0, 0, 1_000_000, 'offset'),
  };
}

export const MAX_METRIC_POSTS = 50;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** `postIds=a,b`: 1..50 uuids, each exactly once. */
export function parsePostIds(raw?: string): string[] {
  const parts = (raw ?? '').split(',').map((s) => s.trim());
  if (parts.length < 1 || parts.length > MAX_METRIC_POSTS) {
    throw new BadRequestException(
      `postIds must list 1 to ${MAX_METRIC_POSTS} ids`,
    );
  }
  if (parts.some((s) => !UUID.test(s))) {
    throw new BadRequestException('postIds must be comma-separated uuids');
  }
  return [...new Set(parts)];
}
