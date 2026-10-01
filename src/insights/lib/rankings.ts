import { round1 } from '../../post-performance/period';
import {
  POST_FORMATS,
  type InsightPost,
  type PostFormat,
} from './insight-post';

export const TOP_KEYS = ['impressions', 'engagements', 'comments'] as const;
export type TopKey = (typeof TOP_KEYS)[number];

/**
 * The best `n` posts by `key`, newest first on a tie. A post with nothing on
 * that key (not measured yet, or zero) is never "top performing".
 */
export function topPosts(
  posts: InsightPost[],
  key: TopKey,
  n = 3,
): InsightPost[] {
  return posts
    .filter((p) => (p[key] ?? 0) > 0)
    .sort(
      (a, b) =>
        (b[key] ?? 0) - (a[key] ?? 0) ||
        b.publishedAt.localeCompare(a.publishedAt),
    )
    .slice(0, n);
}

export interface FormatStat {
  format: PostFormat;
  posts: number;
  /** Posts whose platform reports impressions: what the rate is built on. */
  ratedPosts: number;
  engagementRate: number | null;
  avgImpressions: number | null;
}

/** Each format's rate over its rated posts, highest first; unknowns counted apart. */
export function formatStats(posts: InsightPost[]): {
  formats: FormatStat[];
  unknownFormatPosts: number;
} {
  const acc = new Map<
    PostFormat,
    {
      posts: number;
      rated: number;
      ratedEngagements: number;
      impressions: number;
    }
  >();
  let unknownFormatPosts = 0;

  for (const p of posts) {
    if (p.format === 'unknown') {
      unknownFormatPosts += 1;
      continue;
    }
    const a = acc.get(p.format) ?? {
      posts: 0,
      rated: 0,
      ratedEngagements: 0,
      impressions: 0,
    };
    a.posts += 1;
    if (p.impressions !== null) {
      a.rated += 1;
      a.ratedEngagements += p.engagements;
      a.impressions += p.impressions;
    }
    acc.set(p.format, a);
  }

  const formats = POST_FORMATS.filter((f) => acc.has(f))
    .map((format): FormatStat => {
      const a = acc.get(format)!;
      return {
        format,
        posts: a.posts,
        ratedPosts: a.rated,
        engagementRate:
          a.impressions > 0
            ? round1((a.ratedEngagements / a.impressions) * 100)
            : null,
        avgImpressions: a.rated ? Math.round(a.impressions / a.rated) : null,
      };
    })
    // Rates are never negative, so -1 sorts an unrated format last.
    .sort((x, y) => (y.engagementRate ?? -1) - (x.engagementRate ?? -1));

  return { formats, unknownFormatPosts };
}

export const SLOT_HOURS = 4;
export const SLOT_COUNT = 24 / SLOT_HOURS;
/** A cell's rate from a single post would just be that post. */
export const MIN_CELL_RATED = 2;
/** Below this, any "best time" is noise. */
export const MIN_RATED_POSTS = 6;

const WEEKDAY: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

export interface BestTimeCell {
  /** 0 = Monday. */
  weekday: number;
  /** 0–5: 4-hour blocks from midnight. */
  slot: number;
  posts: number;
  engagementRate: number | null;
}

export interface BestTimes {
  cells: BestTimeCell[];
  best: { weekday: number; slot: number }[];
  ratedPosts: number;
}

/**
 * When the workspace's posts did best: weekday × 4-hour block in `tz`, by
 * engagement rate over rated posts. Platforms don't say when followers are
 * online, so this measures our own posts instead.
 */
export function bestTimes(posts: InsightPost[], tz: string): BestTimes {
  const clock = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  });
  const acc = Array.from({ length: 7 * SLOT_COUNT }, () => ({
    posts: 0,
    rated: 0,
    ratedEngagements: 0,
    impressions: 0,
  }));
  let ratedPosts = 0;

  for (const p of posts) {
    const parts = clock.formatToParts(new Date(p.publishedAt));
    const weekday = WEEKDAY[parts.find((x) => x.type === 'weekday')!.value];
    const hour = Number(parts.find((x) => x.type === 'hour')!.value) % 24;
    const cell = acc[weekday * SLOT_COUNT + Math.floor(hour / SLOT_HOURS)];
    cell.posts += 1;
    if (p.impressions !== null) {
      cell.rated += 1;
      cell.ratedEngagements += p.engagements;
      cell.impressions += p.impressions;
      ratedPosts += 1;
    }
  }

  const cells = acc.map(
    (c, i): BestTimeCell => ({
      weekday: Math.floor(i / SLOT_COUNT),
      slot: i % SLOT_COUNT,
      posts: c.posts,
      engagementRate:
        c.rated >= MIN_CELL_RATED && c.impressions > 0
          ? round1((c.ratedEngagements / c.impressions) * 100)
          : null,
    }),
  );

  const best =
    ratedPosts < MIN_RATED_POSTS
      ? []
      : cells
          .filter((c) => c.engagementRate !== null)
          .sort(
            (a, b) =>
              b.engagementRate! - a.engagementRate! || b.posts - a.posts,
          )
          .slice(0, 3)
          .map(({ weekday, slot }) => ({ weekday, slot }));

  return { cells, best, ratedPosts };
}
