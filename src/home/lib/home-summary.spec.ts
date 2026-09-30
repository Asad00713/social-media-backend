import type { PublishedPost } from '../../post-performance/post-performance';
import {
  computeStreakWeeks,
  dailySeries,
  deltaPct,
  followersGainedOf,
  isPulseRange,
  summarizeChannel,
  weekStart,
  type FollowerRow,
} from './home-summary';

const row = (over: Partial<FollowerRow>): FollowerRow => ({
  channelId: 1,
  date: '2026-09-20',
  followersAtEndOfDay: null,
  followersGained: null,
  ...over,
});

const post = (over: Partial<PublishedPost>): PublishedPost => ({
  postId: 'p1',
  channelId: 1,
  publishedOn: '2026-09-20',
  likes: null,
  comments: null,
  shares: null,
  impressions: null,
  ...over,
});

describe('deltaPct', () => {
  it('is the percentage change, one decimal', () => {
    expect(deltaPct(12, 10)).toBe(20);
    expect(deltaPct(326, 340)).toBe(-4.1);
  });
  it('is null when there is nothing to compare against', () => {
    expect(deltaPct(5, 0)).toBeNull();
    expect(deltaPct(5, null)).toBeNull();
    expect(deltaPct(null, 5)).toBeNull();
  });
});

describe('followersGainedOf', () => {
  it('adds the daily gains across channels, losses included', () => {
    expect(
      followersGainedOf([
        row({ channelId: 1, followersGained: 5 }),
        row({ channelId: 2, followersGained: -2 }),
        row({ channelId: 2, date: '2026-09-21', followersGained: 4 }),
      ]),
    ).toBe(7);
  });

  it('is null, not zero, when no channel reported a change', () => {
    expect(followersGainedOf([row({})])).toBeNull();
    expect(followersGainedOf([])).toBeNull();
  });
});

describe('summarizeChannel', () => {
  it('takes the latest follower count and computes growth over the window', () => {
    const c = summarizeChannel(
      7,
      [
        row({
          channelId: 7,
          date: '2026-09-21',
          followersAtEndOfDay: 1000,
          followersGained: 10,
        }),
        row({
          channelId: 7,
          date: '2026-09-23',
          followersAtEndOfDay: 1030,
          followersGained: 20,
        }),
      ],
      3,
    );
    expect(c).toEqual({
      channelId: 7,
      followers: 1030,
      followersGained: 30,
      growthPct: 3,
      postsThisWeek: 3,
    });
  });

  it('has no growth when the starting count is unknown or zero', () => {
    expect(summarizeChannel(7, [], 0).growthPct).toBeNull();
    expect(
      summarizeChannel(
        7,
        [row({ channelId: 7, followersAtEndOfDay: 5, followersGained: 5 })],
        0,
      ).growthPct,
    ).toBeNull();
  });
});

describe('weekStart', () => {
  it('is Monday 00:00 UTC of the week', () => {
    expect(weekStart(new Date('2026-09-28T10:00:00Z')).toISOString()).toBe(
      '2026-09-28T00:00:00.000Z',
    );
    expect(weekStart(new Date('2026-09-27T23:00:00Z')).toISOString()).toBe(
      '2026-09-21T00:00:00.000Z',
    );
  });
});

describe('computeStreakWeeks', () => {
  const now = new Date('2026-09-30T12:00:00Z'); // Wednesday
  const d = (s: string) => new Date(s);

  it('counts consecutive weeks including this one', () => {
    expect(
      computeStreakWeeks(
        [
          d('2026-09-29T09:00Z'),
          d('2026-09-22T09:00Z'),
          d('2026-09-15T09:00Z'),
        ],
        now,
      ),
    ).toBe(3);
  });

  it("keeps last week's streak alive when nothing is published yet this week", () => {
    expect(
      computeStreakWeeks([d('2026-09-22T09:00Z'), d('2026-09-16T09:00Z')], now),
    ).toBe(2);
  });

  it('stops at the first empty week', () => {
    expect(
      computeStreakWeeks([d('2026-09-29T09:00Z'), d('2026-09-08T09:00Z')], now),
    ).toBe(1);
  });

  it('is zero when the last two weeks are empty', () => {
    expect(computeStreakWeeks([d('2026-09-08T09:00Z')], now)).toBe(0);
    expect(computeStreakWeeks([], now)).toBe(0);
  });
});

describe('dailySeries', () => {
  it('puts each post on the day it went out, summed across channels', () => {
    const series = dailySeries(
      [
        post({
          postId: 'a',
          publishedOn: '2026-09-21',
          likes: 5,
          comments: 1,
          impressions: 100,
        }),
        post({
          postId: 'b',
          channelId: 2,
          publishedOn: '2026-09-21',
          shares: 4,
          impressions: 50,
        }),
        post({ postId: 'c', publishedOn: '2026-09-23', likes: 2 }),
      ],
      [row({ date: '2026-09-21', followersGained: 3 })],
      '2026-09-21',
      '2026-09-23',
    );
    expect(series).toEqual([
      {
        date: '2026-09-21',
        postsPublished: 2,
        impressions: 150,
        engagements: 10,
        followersGained: 3,
      },
      // A day with nothing at all is still on the line, at zero.
      {
        date: '2026-09-22',
        postsPublished: 0,
        impressions: null,
        engagements: 0,
        followersGained: null,
      },
      {
        date: '2026-09-23',
        postsPublished: 1,
        impressions: null,
        engagements: 2,
        followersGained: null,
      },
    ]);
  });

  it('leaves out posts and follower days outside the window', () => {
    const series = dailySeries(
      [post({ publishedOn: '2026-09-20', likes: 9 })],
      [row({ date: '2026-09-20', followersGained: 9 })],
      '2026-09-21',
      '2026-09-21',
    );
    expect(series).toEqual([
      {
        date: '2026-09-21',
        postsPublished: 0,
        impressions: null,
        engagements: 0,
        followersGained: null,
      },
    ]);
  });

  it('crosses a month end', () => {
    expect(
      dailySeries([], [], '2026-09-29', '2026-10-02').map((d) => d.date),
    ).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  });
});

describe('isPulseRange', () => {
  it('accepts 7, 30 and 90 days only', () => {
    expect([7, 30, 90].every(isPulseRange)).toBe(true);
    expect([0, 1, 14, 31, 365, NaN].some(isPulseRange)).toBe(false);
  });
});
