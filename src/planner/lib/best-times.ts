import { SupportedPlatform } from '../../drizzle/schema/channels.schema';
import {
  engagementsOf,
  type PublishedPost,
} from '../../post-performance/post-performance';
import { isMeasured, median } from '../../post-performance/engagement-stats';
import { generalWindowsFor } from './general-times';
import { zonedClock } from './workspace-time';

export const BEST_TIMES_WINDOW_DAYS = 90;
export const MIN_POSTS_FOR_OWN = 15;
export const MIN_POSTS_PER_BUCKET = 2;

const DAY_MS = 86_400_000;

export interface BestTimeWindow {
  /** 0 = Sunday */
  weekday: number;
  hour: number;
  /** x your usual; null for a general time, which has no usual. */
  multiplier: number | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The workspace's own best (weekday, hour) buckets from measured posts. */
export function computeOwnBestTimes(
  posts: PublishedPost[],
  timeZone: string,
  now: Date,
): { postCount: number; windows: BestTimeWindow[] } {
  const since = now.getTime() - BEST_TIMES_WINDOW_DAYS * DAY_MS;
  const used = posts.filter((p) => {
    const t = Date.parse(p.publishedAt);
    return t >= since && t <= now.getTime() && isMeasured(p);
  });

  const buckets = new Map<
    string,
    { weekday: number; hour: number; values: number[] }
  >();
  for (const p of used) {
    const { weekday, hour } = zonedClock(new Date(p.publishedAt), timeZone);
    const key = `${weekday}-${hour}`;
    const b = buckets.get(key) ?? { weekday, hour, values: [] };
    b.values.push(engagementsOf(p));
    buckets.set(key, b);
  }

  const baseline = Math.max(median(used.map(engagementsOf)) ?? 0, 1);
  const ranked = [...buckets.values()]
    .filter((b) => b.values.length >= MIN_POSTS_PER_BUCKET)
    .map((b) => ({
      weekday: b.weekday,
      hour: b.hour,
      size: b.values.length,
      multiplier: round2((median(b.values) ?? 0) / baseline),
    }))
    .sort(
      (a, b) =>
        b.multiplier - a.multiplier ||
        b.size - a.size ||
        a.weekday - b.weekday ||
        a.hour - b.hour,
    );

  return {
    postCount: used.length,
    windows: ranked.map(({ weekday, hour, multiplier }) => ({
      weekday,
      hour,
      multiplier,
    })),
  };
}

export function resolveBestTimes(args: {
  platform: SupportedPlatform;
  posts: PublishedPost[];
  timeZone: string;
  now: Date;
  forceGeneral: boolean;
}): {
  source: 'own' | 'general';
  postCount: number;
  windowDays: 90;
  windows: BestTimeWindow[];
} {
  const own = computeOwnBestTimes(args.posts, args.timeZone, args.now);
  if (args.forceGeneral || own.postCount < MIN_POSTS_FOR_OWN) {
    return {
      source: 'general',
      postCount: own.postCount,
      windowDays: BEST_TIMES_WINDOW_DAYS,
      windows: generalWindowsFor(args.platform).map((w) => ({
        ...w,
        multiplier: null,
      })),
    };
  }
  return {
    source: 'own',
    postCount: own.postCount,
    windowDays: BEST_TIMES_WINDOW_DAYS,
    windows: own.windows,
  };
}
