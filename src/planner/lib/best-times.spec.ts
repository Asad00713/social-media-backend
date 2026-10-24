import type { PublishedPost } from '../../post-performance/post-performance';
import {
  computeOwnBestTimes,
  resolveBestTimes,
  BEST_TIMES_WINDOW_DAYS,
  MIN_POSTS_FOR_OWN,
} from './best-times';

const NOW = new Date('2026-06-15T12:00:00Z');
const DAY = 86_400_000;
const daysAgo = (d: number, at = NOW) => new Date(at.getTime() - d * DAY);

let seq = 0;
const post = (
  at: Date,
  likes: number | null = 1,
  over: Partial<PublishedPost> = {},
): PublishedPost => ({
  postId: `p${seq++}`,
  channelId: 1,
  publishedOn: at.toISOString().slice(0, 10),
  likes,
  comments: likes === null ? null : 0,
  shares: likes === null ? null : 0,
  impressions: null,
  publishedAt: at.toISOString(),
  content: '',
  mediaItems: [],
  imported: false,
  permalink: null,
  mediaType: null,
  ...over,
});

const many = (n: number, likes = 1) =>
  Array.from({ length: n }, (_, i) => post(daysAgo(i + 1), likes));

describe('best-times', () => {
  it('constants', () => {
    expect(BEST_TIMES_WINDOW_DAYS).toBe(90);
    expect(MIN_POSTS_FOR_OWN).toBe(15);
  });

  it('14 measured posts are general, 15 are own', () => {
    expect(
      resolveBestTimes({
        platform: 'instagram',
        posts: many(14),
        timeZone: 'UTC',
        now: NOW,
        forceGeneral: false,
      }).source,
    ).toBe('general');
    expect(
      resolveBestTimes({
        platform: 'instagram',
        posts: many(15),
        timeZone: 'UTC',
        now: NOW,
        forceGeneral: false,
      }).source,
    ).toBe('own');
  });

  it('unmeasured posts do not count', () => {
    const posts = [
      ...many(14),
      ...Array.from({ length: 6 }, (_, i) => post(daysAgo(i + 1), null)),
    ];
    const r = resolveBestTimes({
      platform: 'instagram',
      posts,
      timeZone: 'UTC',
      now: NOW,
      forceGeneral: false,
    });
    expect(r.postCount).toBe(14);
    expect(r.source).toBe('general');
  });

  it('forceGeneral wins over plenty of posts', () => {
    const r = resolveBestTimes({
      platform: 'instagram',
      posts: many(40),
      timeZone: 'UTC',
      now: NOW,
      forceGeneral: true,
    });
    expect(r.source).toBe('general');
    expect(r.windows.length).toBeGreaterThan(0);
    expect(r.windows.every((w) => w.multiplier === null)).toBe(true);
    expect(r.windowDays).toBe(90);
  });

  it('a platform with no research and little data has no windows', () => {
    const r = resolveBestTimes({
      platform: 'youtube',
      posts: many(3),
      timeZone: 'UTC',
      now: NOW,
      forceGeneral: false,
    });
    expect(r).toMatchObject({ source: 'general', windows: [] });
  });

  it('a bucket needs two posts', () => {
    const t = new Date('2026-06-10T09:00:00Z');
    const one = computeOwnBestTimes([post(t)], 'UTC', NOW);
    expect(one.windows).toEqual([]);
    const two = computeOwnBestTimes(
      [post(t), post(new Date(t.getTime() - 7 * DAY))],
      'UTC',
      NOW,
    );
    expect(two.windows).toHaveLength(1);
  });

  it('keeps 89 day old posts and drops 91 day old ones', () => {
    const base = new Date('2026-06-15T09:00:00Z');
    const r = computeOwnBestTimes(
      [post(daysAgo(89, base)), post(daysAgo(91, base))],
      'UTC',
      NOW,
    );
    expect(r.postCount).toBe(1);
  });

  it('buckets by the workspace zone, not UTC', () => {
    // 20:30Z Monday is 01:30 Tuesday in Karachi (UTC+5).
    const mon = new Date('2026-06-08T20:30:00Z');
    const r = computeOwnBestTimes(
      [post(mon), post(new Date(mon.getTime() - 7 * DAY))],
      'Asia/Karachi',
      NOW,
    );
    expect(r.windows).toHaveLength(1);
    expect(r.windows[0]).toMatchObject({ weekday: 2, hour: 1 });
  });

  it('shares one bucket across a DST change', () => {
    const now = new Date('2026-03-30T12:00:00Z');
    const r = computeOwnBestTimes(
      [
        post(new Date('2026-03-01T14:00:00Z')), // EST, Sunday 09:00
        post(new Date('2026-03-15T13:00:00Z')), // EDT, Sunday 09:00
      ],
      'America/New_York',
      now,
    );
    expect(r.windows).toHaveLength(1);
    expect(r.windows[0]).toMatchObject({ weekday: 0, hour: 9 });
  });

  it('multiplier is bucket median over channel median, 2dp', () => {
    const t = new Date('2026-06-10T09:00:00Z');
    const hot = [post(t, 6), post(new Date(t.getTime() - 7 * DAY), 6)];
    const rest = [1, 3, 3, 3, 3].map((l, i) =>
      post(new Date(`2026-06-0${i + 1}T03:00:00Z`), l),
    );
    // channel median of [6,6,1,3,3,3,3] = 3
    const r = computeOwnBestTimes([...hot, ...rest], 'UTC', NOW);
    expect(r.windows[0]).toMatchObject({ weekday: 3, hour: 9, multiplier: 2 });
  });

  it('a zero channel median divides by 1', () => {
    const t = new Date('2026-06-10T09:00:00Z');
    const posts = [
      post(t, 5),
      post(new Date(t.getTime() - 7 * DAY), 5),
      post(daysAgo(1), 0),
      post(daysAgo(2), 0),
      post(daysAgo(3), 0),
      post(daysAgo(4), 0),
    ];
    const r = computeOwnBestTimes(posts, 'UTC', NOW);
    const w = r.windows.find((x) => x.hour === 9);
    expect(w?.multiplier).toBe(5);
    expect(r.windows.every((x) => Number.isFinite(x.multiplier))).toBe(true);
  });

  it('sorts by multiplier, then size, then weekday, then hour', () => {
    const at = (iso: string, likes: number) => post(new Date(iso), likes);
    const posts = [
      // Wed 10: 2 posts, likes 4
      at('2026-06-10T10:00:00Z', 4),
      at('2026-06-03T10:00:00Z', 4),
      // Tue 08: 2 posts, likes 4 (same multiplier, same size, earlier weekday)
      at('2026-06-09T08:00:00Z', 4),
      at('2026-06-02T08:00:00Z', 4),
      // Tue 07: 2 posts, likes 4 (earlier hour)
      at('2026-06-09T07:00:00Z', 4),
      at('2026-06-02T07:00:00Z', 4),
      // Fri 15: 3 posts, likes 4 (bigger bucket first)
      at('2026-06-12T15:00:00Z', 4),
      at('2026-06-05T15:00:00Z', 4),
      at('2026-05-29T15:00:00Z', 4),
      // Mon 01: 2 posts, likes 8 (best multiplier)
      at('2026-06-08T01:00:00Z', 8),
      at('2026-06-01T01:00:00Z', 8),
    ];
    const r = computeOwnBestTimes(posts, 'UTC', NOW);
    expect(r.windows.map((w) => [w.weekday, w.hour])).toEqual([
      [1, 1],
      [5, 15],
      [2, 7],
      [2, 8],
      [3, 10],
    ]);
  });

  it('is own with no windows at 15 posts that share no bucket', () => {
    const posts = Array.from({ length: 15 }, (_, i) =>
      post(new Date(NOW.getTime() - (i + 1) * DAY - i * 3_600_000 * 7)),
    );
    const r = resolveBestTimes({
      platform: 'instagram',
      posts,
      timeZone: 'UTC',
      now: NOW,
      forceGeneral: false,
    });
    expect(r.source).toBe('own');
    expect(r.postCount).toBe(15);
    expect(r.windows).toEqual([]);
  });
});
