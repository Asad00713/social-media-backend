import { addDays, datesBetween } from '../../post-performance/period';
import type { FollowerRow } from '../../post-performance/followers';
import type { PublishedPost } from '../../post-performance/post-performance';
import type { Brief } from './brief';
import type { InsightPost } from './insight-post';
import {
  channelEngagementDeltas,
  periodBrief,
  proseName,
  quietFollowers,
  rangeKindOf,
  type BriefContext,
} from './brief-inputs';

const row = (
  date: string,
  gained: number | null,
  followers: number | null = 1000,
  channelId = 3,
): FollowerRow => ({
  channelId,
  date,
  followersAtEndOfDay: followers,
  followersGained: gained,
});

describe('quietFollowers', () => {
  const LAST = '2026-09-30';
  const YESTERDAY = '2026-11-03';
  const growing = [row('2026-09-26', 2), row('2026-09-28', 2)];

  it('reports the count, the gain since and the daily rate before', () => {
    expect(
      quietFollowers(
        [...growing, row('2026-10-10', 0, 1004), row('2026-11-03', 0, 1004)],
        3,
        LAST,
        YESTERDAY,
        YESTERDAY,
      ),
    ).toEqual({ count: 1004, gainedSince: 0, priorPerDay: 2 });
  });

  it('is null when the window ended before yesterday', () => {
    expect(
      quietFollowers(
        [...growing, row('2026-10-10', 0)],
        3,
        LAST,
        YESTERDAY,
        '2026-10-20',
      ),
    ).toBeNull();
  });

  it('is null without a gain reported on both sides of the last post', () => {
    expect(quietFollowers(growing, 3, LAST, YESTERDAY, YESTERDAY)).toBeNull();
    expect(
      quietFollowers([row('2026-10-10', 0)], 3, LAST, YESTERDAY, YESTERDAY),
    ).toBeNull();
  });

  it('is null when no follower count is reported, and ignores other channels', () => {
    expect(
      quietFollowers(
        [...growing, row('2026-10-10', 0)].map((r) => ({
          ...r,
          followersAtEndOfDay: null,
        })),
        3,
        LAST,
        YESTERDAY,
        YESTERDAY,
      ),
    ).toBeNull();
    expect(
      quietFollowers(
        [...growing, row('2026-10-10', 0)],
        4,
        LAST,
        YESTERDAY,
        YESTERDAY,
      ),
    ).toBeNull();
  });
});

describe('proseName and rangeKindOf', () => {
  it('drops a parenthesised suffix from a platform label', () => {
    expect(proseName('X (Twitter)')).toBe('X');
    expect(proseName('Instagram')).toBe('Instagram');
    expect(proseName('Google Business')).toBe('Google Business');
  });

  it('a preset length ending yesterday is a preset, anything else is picked', () => {
    expect(rangeKindOf(30, '2026-11-03', '2026-11-03')).toBe('preset');
    expect(rangeKindOf(14, '2026-11-03', '2026-11-03')).toBe('custom');
    expect(rangeKindOf(30, '2026-10-20', '2026-11-03')).toBe('custom');
  });
});

const mkPost = (
  channelId: number,
  publishedOn: string,
  likes = 5,
): PublishedPost => ({
  postId: `${channelId}-${publishedOn}`,
  channelId,
  publishedOn,
  likes,
  comments: 0,
  shares: 0,
  impressions: null,
  reach: null,
  saved: null,
  follows: null,
  syncedAt: null,
  publishedAt: `${publishedOn}T10:00:00.000Z`,
  content: '',
  mediaItems: [],
  imported: false,
  permalink: null,
  mediaType: null,
});
const daily = (channelId: number, from: string, to: string, likes: number) =>
  datesBetween(from, to).map((d) => mkPost(channelId, d, likes));

describe('channelEngagementDeltas', () => {
  const window = {
    from: '2026-10-01',
    to: '2026-10-07',
    previousFrom: '2026-09-24',
    previousTo: '2026-09-30',
  };

  it('compares each channel with its own usual and leaves a silent one null', () => {
    const published = [
      // 10 a day for three months: every 7-day stretch is 70.
      ...daily(1, '2026-07-01', '2026-09-30', 10),
      // 20 a day in the window: 140, +100%.
      ...daily(1, '2026-10-01', '2026-10-07', 20),
      // Channel 2 posted before the window but not in it.
      ...daily(2, '2026-07-01', '2026-09-30', 10),
    ];
    expect(channelEngagementDeltas([1, 2], published, window)).toEqual([
      { channelId: 1, posts: 7, deltaPct: 100 },
      { channelId: 2, posts: 0, deltaPct: null },
    ]);
  });

  it('is null for a channel without enough history for a usual', () => {
    const published = daily(3, '2026-10-01', '2026-10-07', 20);
    expect(channelEngagementDeltas([3], published, window)).toEqual([
      { channelId: 3, posts: 7, deltaPct: null },
    ]);
  });
});

describe('periodBrief: quiet channel and platform names', () => {
  const NOW = new Date('2026-11-04T09:00:00.000Z');
  const linkedin = [
    '2026-09-02',
    '2026-09-09',
    '2026-09-16',
    '2026-09-23',
    '2026-09-30',
  ].map((d) => mkPost(2, d));
  const ig = datesBetween('2026-10-20', '2026-11-02').map((d) => mkPost(1, d));
  const ctx = (to: string): BriefContext => ({
    days: 14,
    window: {
      from: addDays(to, -13),
      to,
      previousFrom: addDays(to, -27),
      previousTo: addDays(to, -14),
    },
    compare: 'none',
    now: NOW,
    channels: [
      {
        id: 1,
        platformName: 'X (Twitter)',
        accountName: 'a',
        isActive: true,
        connectionStatus: 'connected',
      },
      {
        id: 2,
        platformName: 'LinkedIn',
        accountName: 'b',
        isActive: true,
        connectionStatus: 'connected',
      },
    ],
    freshness: [1, 2].map((id) => ({
      channelId: id,
      lastSyncedAt: null,
      failing: false,
      isActive: true,
      connectionStatus: 'connected',
      backfill: 'completed' as const,
      reportsViews: true,
      reportsReach: false,
      reportsFollowers: false,
    })),
    published: [...linkedin, ...ig],
    sample: [...linkedin, ...ig],
    followers: [],
    posts: ig.map((p) => ({ postId: p.postId, channelId: 1 }) as InsightPost),
    standout: {
      above: [],
      below: [],
      aboveCount: 0,
      belowCount: 0,
      aboveAll: [],
    },
    impressions: { value: 1000, previous: null, deltaPct: null },
    engagements: { value: 70, previous: null, deltaPct: null },
  });
  const textOf = (b: Brief) =>
    b.status === 'ready' ? b.segments.map((s) => s.text).join('') : b.text;

  it('names the quiet channel when the window ends yesterday', () => {
    const b = periodBrief(ctx('2026-11-03'));
    expect(textOf(b)).toContain('LinkedIn has had no posts since Sep 30');
  });

  it('drops it for a past picked range', () => {
    const b = periodBrief(ctx('2026-11-02'));
    expect(textOf(b)).not.toContain('LinkedIn');
    expect(b.status === 'ready' && b.sources).toEqual([]);
  });

  it('picks drivers from every Above post, not the 3 shown', () => {
    const d = {
      postId: 'D',
      channelId: 1,
      title: 'D',
      format: 'video',
      impressions: 900,
      engagements: 5,
      usualMultiplier: 1.6,
    } as InsightPost;
    const b = periodBrief({
      ...ctx('2026-11-03'),
      standout: {
        above: [],
        below: [],
        aboveCount: 1,
        belowCount: 0,
        aboveAll: [d],
      },
    });
    expect(textOf(b)).toContain('mostly from one X video: D.');
  });

  it('calls X by its short name in prose and sources', () => {
    const c = ctx('2026-11-03');
    // X is the quiet one this time: its last posts are old, LinkedIn's recent.
    const xPosts = [
      '2026-09-02',
      '2026-09-09',
      '2026-09-16',
      '2026-09-23',
      '2026-09-30',
    ].map((d) => mkPost(1, d));
    const liPosts = datesBetween('2026-10-20', '2026-11-02').map((d) =>
      mkPost(2, d),
    );
    const b = periodBrief({
      ...c,
      published: [...xPosts, ...liPosts],
      sample: [...xPosts, ...liPosts],
      posts: liPosts.map(
        (p) => ({ postId: p.postId, channelId: 2 }) as InsightPost,
      ),
    });
    expect(textOf(b)).toContain('X has had no posts since Sep 30');
    expect(textOf(b)).not.toContain('Twitter');
    expect(b.status === 'ready' && b.sources[0]).toMatchObject({
      title: 'a · X',
    });
  });
});
