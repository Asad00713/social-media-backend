import { BadRequestException } from '@nestjs/common';
import {
  PERIOD_DAYS,
  isPeriodDays,
  type PeriodDays,
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
 * The asked-for channels narrowed to `allowed`: the workspace's active social
 * channels. Ids outside it are dropped, never queried. A stale id left by a
 * disconnect shouldn't break the page, and dropping says nothing about other
 * workspaces. With no `channels` param, every allowed channel counts.
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

export const SORT_KEYS = [
  'publishedAt',
  'impressions',
  'engagements',
  'engagementRate',
  'likes',
  'comments',
  'shares',
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
