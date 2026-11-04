import {
  median,
  MIN_POSTS_FOR_USUAL,
} from '../../post-performance/engagement-stats';
import { round1 } from '../../post-performance/period';
import type { PublishedPost } from '../../post-performance/post-performance';
import {
  MIN_CELL_POSTS,
  slotOf,
  type BestSlot,
  type BestTimeGrid,
} from './best-time';
import {
  SETTLING_DAYS,
  type InsightFormat,
  type InsightPost,
} from './insight-post';
import { MIN_FORMAT_POSTS, type WorkBar } from './what-works';

/** A multiplier at or above MULT_UP is "up"; at or below MULT_DOWN, "down". */
export const MULT_UP = 1.2;
export const MULT_DOWN = 0.8;

export type TileKey =
  | 'reach'
  | 'views'
  | 'likes'
  | 'comments'
  | 'shares'
  | 'saves'
  | 'newFollowers'
  | 'rate';

export interface PostTile {
  key: TileKey;
  value: number;
  /** Median of the channel's posts that report this metric; null under 5. */
  usual: number | null;
}

export interface PostVerdict {
  kind: 'up' | 'flat' | 'down' | 'settling' | 'none';
  title: string;
  body: string;
}

const PLATFORM_NAMES: Record<string, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  twitter: 'X',
  threads: 'Threads',
  linkedin: 'LinkedIn',
  pinterest: 'Pinterest',
  bluesky: 'Bluesky',
  mastodon: 'Mastodon',
};

export const platformNameOf = (platform: string): string =>
  PLATFORM_NAMES[platform] ??
  platform.charAt(0).toUpperCase() + platform.slice(1);

type Read = (p: PublishedPost) => number | null;

/** Engagements over views, one decimal; null without views. */
const rateOf: Read = (p) => {
  if (!p.impressions) return null;
  const e = (p.likes ?? 0) + (p.comments ?? 0) + (p.shares ?? 0);
  return round1((e / p.impressions) * 100);
};

/** Each tile, in display order, and how it reads off a post. */
const TILES: { key: TileKey; read: Read; decimals: boolean }[] = [
  { key: 'reach', read: (p) => p.reach, decimals: false },
  { key: 'views', read: (p) => p.impressions, decimals: false },
  { key: 'likes', read: (p) => p.likes, decimals: false },
  { key: 'comments', read: (p) => p.comments, decimals: false },
  { key: 'shares', read: (p) => p.shares, decimals: false },
  { key: 'saves', read: (p) => p.saved, decimals: false },
  { key: 'newFollowers', read: (p) => p.follows, decimals: false },
  { key: 'rate', read: rateOf, decimals: true },
];

/**
 * The metric tiles for `post`: a tile exists only when the platform reported
 * that number for this post (never a 0 for "not shared"). Its usual is the
 * median of that metric over `sample` (the channel's posts of the last 90
 * days) that report it, null under MIN_POSTS_FOR_USUAL of them.
 */
export function tilesOf(
  post: PublishedPost,
  sample: PublishedPost[],
): PostTile[] {
  return TILES.flatMap(({ key, read, decimals }): PostTile[] => {
    const value = read(post);
    if (value === null) return [];
    const reported = sample.flatMap((p) => {
      const v = read(p);
      return v === null ? [] : [v];
    });
    const m = reported.length >= MIN_POSTS_FOR_USUAL ? median(reported) : null;
    return [
      {
        key,
        value,
        usual: m === null ? null : decimals ? round1(m) : Math.round(m),
      },
    ];
  });
}

const count = (n: number): string => Math.round(n).toLocaleString('en-US');

/**
 * The dialog's verdict (spec 7.4). A post under SETTLING_DAYS is settling
 * whatever its multiplier; without a multiplier there is no usual yet.
 * `usualMedian` is the channel's median engagements, `rank` the post's place
 * among the last 30 days' posts (1 = best).
 */
export function verdictOf(
  post: Pick<InsightPost, 'usualMultiplier' | 'isSettling' | 'engagements'>,
  usualMedian: number | null,
  rank: number | null,
  platformName: string,
): PostVerdict {
  if (post.isSettling) {
    return {
      kind: 'settling',
      title: 'Still settling',
      body: `This post is under ${SETTLING_DAYS} days old, so its numbers can still change.`,
    };
  }
  const x = post.usualMultiplier;
  if (x === null || usualMedian === null) {
    return {
      kind: 'none',
      title: 'No usual to compare yet',
      body: `${platformName} needs about ${MIN_POSTS_FOR_USUAL} posts with numbers first.`,
    };
  }
  const against = `${count(post.engagements)} engagements against a usual ${count(usualMedian)}.`;
  if (x >= MULT_UP) {
    return {
      kind: 'up',
      title: `${x.toFixed(1)}× your usual engagement`,
      body: rank === 1 ? 'Your best post this month.' : against,
    };
  }
  if (x <= MULT_DOWN) {
    return {
      kind: 'down',
      title: `${x.toFixed(1)}× your usual engagement`,
      body: against,
    };
  }
  return { kind: 'flat', title: 'About your usual engagement', body: against };
}

const FORMAT_WORDS: Record<
  Exclude<InsightFormat, 'unknown'>,
  [singular: string, plural: string]
> = {
  video: ['video', 'videos'],
  image: ['photo', 'photos'],
  carousel: ['carousel', 'carousels'],
  link: ['link post', 'link posts'],
  text: ['text post', 'text posts'],
};

/** The best cells of a grid, best first; none while the grid has no best. */
export function topSlots(grid: BestTimeGrid, n = 3): BestSlot[] {
  if (!grid.best) return [];
  return grid.cells
    .filter((c) => c.value !== null && c.value > 0 && c.posts >= MIN_CELL_POSTS)
    .sort((a, b) => b.value! - a.value! || b.posts - a.posts)
    .slice(0, n)
    .map(({ weekday, slot }) => ({ weekday, slot }));
}

/** `Wed 7 PM`: the post's own weekday and hour on the workspace's clock. */
function clockLabel(at: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: 'numeric',
    hour12: true,
  }).formatToParts(at);
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  return `${get('weekday')} ${get('hour')} ${get('dayPeriod').toUpperCase()}`;
}

/**
 * Why an up post did well (spec 7.4); the caller shows them for an up verdict
 * only. R1: its format is the best of `formatBars` (best first, each with at
 * least MIN_FORMAT_POSTS posts) and a worse one exists to compare with. R2:
 * it went out in one of the `bestTop3` cells.
 */
export function reasonsOf(
  post: Pick<InsightPost, 'format' | 'publishedAt'>,
  formatBars: WorkBar[],
  bestTop3: BestSlot[],
  tz: string,
): string[] {
  const reasons: string[] = [];
  const eligible = formatBars.filter((b) => b.posts >= MIN_FORMAT_POSTS);
  const best = eligible[0];
  const worst = eligible[eligible.length - 1];
  if (
    best &&
    worst &&
    best !== worst &&
    post.format !== 'unknown' &&
    best.key === post.format &&
    best.median !== null &&
    worst.median !== null &&
    worst.median > 0 &&
    worst.key in FORMAT_WORDS
  ) {
    const [one, many] = FORMAT_WORDS[post.format];
    const [, worstMany] = FORMAT_WORDS[worst.key as keyof typeof FORMAT_WORDS];
    const x = (best.median / worst.median).toFixed(1);
    reasons.push(
      `A ${one}. Your ${many} get ${x}× the engagement of your ${worstMany}.`,
    );
  }
  const at = new Date(post.publishedAt);
  const slot = slotOf(at, tz);
  if (
    bestTop3.some((s) => s.weekday === slot.weekday && s.slot === slot.slot)
  ) {
    reasons.push(`Posted ${clockLabel(at, tz)}, one of your best times.`);
  }
  return reasons;
}
