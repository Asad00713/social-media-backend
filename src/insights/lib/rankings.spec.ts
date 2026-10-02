import type { InsightPost } from './insight-post';
import { bestTimes, formatStats, topPosts } from './rankings';

const ip = (over: Partial<InsightPost>): InsightPost => ({
  postId: 'p',
  channelId: 1,
  publishedAt: '2026-09-21T10:00:00.000Z',
  content: '',
  format: 'image',
  thumbnailUrl: null,
  permalink: null,
  likes: null,
  comments: null,
  shares: null,
  impressions: null,
  engagements: 0,
  engagementRate: null,
  ...over,
});

describe('topPosts', () => {
  it('ranks by the key, newest first on a tie, three at most', () => {
    const top = topPosts(
      [
        ip({ postId: 'a', impressions: 100 }),
        ip({ postId: 'b', impressions: 900 }),
        ip({
          postId: 'c',
          impressions: 500,
          publishedAt: '2026-09-20T00:00:00.000Z',
        }),
        ip({
          postId: 'd',
          impressions: 500,
          publishedAt: '2026-09-22T00:00:00.000Z',
        }),
      ],
      'impressions',
    );
    expect(top.map((p) => p.postId)).toEqual(['b', 'd', 'c']);
  });

  it('never ranks a post with nothing on that key: unmeasured or zero', () => {
    const top = topPosts(
      [
        ip({ postId: 'new' }),
        ip({ postId: 'zero', comments: 0 }),
        ip({ postId: 'x', comments: 2 }),
      ],
      'comments',
    );
    expect(top.map((p) => p.postId)).toEqual(['x']);
  });
});

describe('formatStats', () => {
  it('rates each format over its rated posts, best first, and counts unknowns apart', () => {
    const { formats, unknownFormatPosts } = formatStats([
      ip({ format: 'video', engagements: 30, impressions: 300 }),
      ip({ format: 'video', engagements: 10, impressions: 100 }),
      ip({ format: 'image', engagements: 5, impressions: 500 }),
      ip({ format: 'image', engagements: 99 }), // no impressions: counted, not rated
      ip({ format: 'unknown', engagements: 50, impressions: 50 }),
    ]);
    expect(formats).toEqual([
      {
        format: 'video',
        posts: 2,
        ratedPosts: 2,
        engagementRate: 10,
        avgImpressions: 200,
      },
      {
        format: 'image',
        posts: 2,
        ratedPosts: 1,
        engagementRate: 1,
        avgImpressions: 500,
      },
    ]);
    expect(unknownFormatPosts).toBe(1);
  });

  it('puts a format with no rated posts last', () => {
    const { formats } = formatStats([
      ip({ format: 'text', engagements: 4 }),
      ip({ format: 'image', engagements: 1, impressions: 100 }),
    ]);
    expect(formats.map((f) => f.format)).toEqual(['image', 'text']);
    expect(formats[1].engagementRate).toBeNull();
  });
});

describe('bestTimes', () => {
  // 2026-09-28 is a Monday.
  const at = (
    iso: string,
    engagements: number,
    impressions: number | null = 100,
  ) => ip({ publishedAt: iso, engagements, impressions });

  it('buckets posts by local weekday and 4-hour slot', () => {
    // 20:30 UTC Monday is 01:30 Tuesday in Karachi (UTC+5).
    const { cells } = bestTimes(
      [at('2026-09-28T20:30:00Z', 10), at('2026-09-28T21:00:00Z', 20)],
      'Asia/Karachi',
    );
    const tueNight = cells.find((c) => c.weekday === 1 && c.slot === 0)!;
    expect(tueNight).toEqual({
      weekday: 1,
      slot: 0,
      posts: 2,
      engagementRate: 15,
    });
    expect(cells).toHaveLength(42);
  });

  it('follows the clock across a DST change', () => {
    // New York leaves DST on 2026-11-01. 12:30 UTC is 08:30 EDT on Saturday
    // (slot 2, 08–12) but 07:30 EST on Monday (slot 1, 04–08). A fixed
    // offset would put both in slot 2.
    const { cells } = bestTimes(
      [at('2026-10-31T12:30:00Z', 1), at('2026-11-02T12:30:00Z', 1)],
      'America/New_York',
    );
    expect(cells.find((c) => c.weekday === 5 && c.slot === 2)!.posts).toBe(1);
    expect(cells.find((c) => c.weekday === 0 && c.slot === 1)!.posts).toBe(1);
    expect(cells.find((c) => c.weekday === 0 && c.slot === 2)!.posts).toBe(0);
  });

  it('leaves a cell empty with fewer than two rated posts', () => {
    const { cells } = bestTimes([at('2026-09-28T10:00:00Z', 50)], 'UTC');
    const monMorning = cells.find((c) => c.weekday === 0 && c.slot === 2)!;
    expect(monMorning.posts).toBe(1);
    expect(monMorning.engagementRate).toBeNull();
  });

  it('picks the best three cells only once there are six rated posts', () => {
    const posts = [
      at('2026-09-28T10:00:00Z', 10),
      at('2026-09-28T11:00:00Z', 10), // Mon 08–12: 10%
      at('2026-09-29T18:00:00Z', 30),
      at('2026-09-29T19:00:00Z', 30), // Tue 16–20: 30%
      at('2026-09-30T13:00:00Z', 20),
      at('2026-09-30T14:00:00Z', 20), // Wed 12–16: 20%
      at('2026-10-01T02:00:00Z', 90, null), // unrated: counted, not rated
    ];
    expect(bestTimes(posts, 'UTC')).toMatchObject({
      ratedPosts: 6,
      best: [
        { weekday: 1, slot: 4 },
        { weekday: 2, slot: 3 },
        { weekday: 0, slot: 2 },
      ],
    });
    expect(bestTimes(posts.slice(0, 5), 'UTC').best).toEqual([]);
  });
});
