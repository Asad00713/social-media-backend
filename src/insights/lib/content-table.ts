import { round1 } from '../../post-performance/period';
import {
  POST_FORMATS,
  type InsightPost,
  type PostFormat,
} from './insight-post';
import type { SortKey, TableQuery } from './query';

const sortValue = (p: InsightPost, key: SortKey): number | null => {
  if (key === 'publishedAt') return Date.parse(p.publishedAt);
  if (key === 'usual') return p.usualMultiplier;
  return p[key];
};

/** Newest first, then stable by post and channel. */
const tieBreak = (a: InsightPost, b: InsightPost) =>
  b.publishedAt.localeCompare(a.publishedAt) ||
  a.postId.localeCompare(b.postId) ||
  a.channelId - b.channelId;

/** Rows for the table. An unmeasured value sorts last in either direction. */
export function filterAndSort(
  posts: InsightPost[],
  q: Pick<TableQuery, 'format' | 'sort' | 'order'>,
): InsightPost[] {
  const dir = q.order === 'asc' ? 1 : -1;
  return posts
    .filter((p) => q.format === 'all' || p.format === q.format)
    .sort((a, b) => {
      const va = sortValue(a, q.sort);
      const vb = sortValue(b, q.sort);
      if (va === null || vb === null) {
        if (va === vb) return tieBreak(a, b);
        return va === null ? 1 : -1;
      }
      return (va - vb) * dir || tieBreak(a, b);
    });
}

/** The Posts tab's filter pills and how many rows each would show. */
export type FormatCounts = Record<'all' | PostFormat, number>;

/**
 * Rows per format pill, counted before the format filter. A post of
 * `unknown` format counts under `all` only: no pill shows it alone.
 */
export function formatCountsOf(rows: InsightPost[]): FormatCounts {
  const counts = Object.fromEntries(POST_FORMATS.map((f) => [f, 0])) as Record<
    PostFormat,
    number
  >;
  for (const r of rows) {
    if (r.format !== 'unknown') counts[r.format] += 1;
  }
  return { all: rows.length, ...counts };
}

export interface TableTotals {
  posts: number;
  impressions: number | null;
  engagements: number;
  engagementRate: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
}

/** Sum of the values reported; null when no row reported any. */
const sumReported = (values: (number | null)[]): number | null =>
  values.some((v) => v !== null)
    ? values.reduce<number>((a, v) => a + (v ?? 0), 0)
    : null;

/** The total row: same rate rule as everywhere, rated posts only. */
export function tableTotals(rows: InsightPost[]): TableTotals {
  const impressions = sumReported(rows.map((r) => r.impressions));
  const ratedEngagements = rows
    .filter((r) => r.impressions !== null)
    .reduce((a, r) => a + r.engagements, 0);
  return {
    posts: rows.length,
    impressions,
    engagements: rows.reduce((a, r) => a + r.engagements, 0),
    engagementRate: impressions
      ? round1((ratedEngagements / impressions) * 100)
      : null,
    likes: sumReported(rows.map((r) => r.likes)),
    comments: sumReported(rows.map((r) => r.comments)),
    shares: sumReported(rows.map((r) => r.shares)),
  };
}

const CSV_HEADER = [
  'published_at',
  'channel',
  'platform',
  'format',
  'caption',
  'reach',
  'impressions',
  'engagements',
  'engagement_rate',
  'likes',
  'comments',
  'shares',
  'vs_usual',
  'link',
];

/**
 * One RFC 4180 cell. Text starting with = + - @ tab or CR is prefixed with '
 * so a spreadsheet shows it instead of running it as a formula.
 */
export function csvCell(v: string | number | null): string {
  if (v === null) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface CsvChannel {
  name: string;
  platform: string;
}

/**
 * The CSV body. The BOM is what makes Excel read Urdu and emoji as UTF-8.
 * `vs_usual` is the multiplier (1.5 for 1.5× usual), empty below the floor.
 */
export function postsCsv(
  rows: InsightPost[],
  channels: Map<number, CsvChannel>,
): string {
  const lines = [CSV_HEADER.join(',')];
  for (const r of rows) {
    const ch = channels.get(r.channelId);
    lines.push(
      [
        r.publishedAt,
        ch?.name ?? '',
        ch?.platform ?? '',
        r.format,
        r.content,
        r.reach,
        r.impressions,
        r.engagements,
        r.engagementRate,
        r.likes,
        r.comments,
        r.shares,
        r.usualMultiplier,
        r.permalink,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
