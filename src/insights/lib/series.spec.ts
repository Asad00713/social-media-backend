import type { FollowerRow } from '../../post-performance/followers';
import type { PublishedPost } from '../../post-performance/post-performance';
import { daySeries, followerTotals, rangeTotals } from './series';

const post = (over: Partial<PublishedPost>): PublishedPost => ({
  postId: 'p1',
  channelId: 1,
  publishedOn: '2026-09-21',
  likes: null,
  comments: null,
  shares: null,
  impressions: null,
  publishedAt: '2026-09-21T10:00:00.000Z',
  content: '',
  mediaItems: [],
  imported: false,
  permalink: null,
  mediaType: null,
  reach: null,
  saved: null,
  follows: null,
  syncedAt: null,
  ...over,
});
const row = (over: Partial<FollowerRow>): FollowerRow => ({
  channelId: 1,
  date: '2026-09-21',
  followersAtEndOfDay: null,
  followersGained: null,
  ...over,
});

describe('daySeries', () => {
  it('puts each post on its day and keeps the rate numerator to rated posts', () => {
    const series = daySeries(
      [
        post({ postId: 'a', likes: 10, impressions: 500, reach: 320 }),
        post({ postId: 'b', channelId: 2, likes: 30 }), // reports no impressions
      ],
      [
        row({
          date: '2026-09-21',
          followersAtEndOfDay: 900,
          followersGained: 12,
        }),
      ],
      '2026-09-21',
      '2026-09-22',
    );
    expect(series).toEqual([
      {
        date: '2026-09-21',
        postsPublished: 2,
        impressions: 500,
        reach: 320,
        engagements: 40,
        likes: 40,
        comments: 0,
        shares: 0,
        ratedEngagements: 10,
        followers: 900,
        followersGained: 12,
      },
      // Nothing posted: zeros, and followers carried forward.
      {
        date: '2026-09-22',
        postsPublished: 0,
        impressions: null,
        reach: null,
        engagements: 0,
        likes: 0,
        comments: 0,
        shares: 0,
        ratedEngagements: 0,
        followers: 900,
        followersGained: null,
      },
    ]);
  });

  it('splits each day into likes, comments and shares that add up to engagements', () => {
    const series = daySeries(
      [
        post({ postId: 'a', likes: 10, comments: 3, shares: 1 }),
        post({
          postId: 'b',
          channelId: 2,
          likes: 5,
          comments: null,
          shares: 4,
        }),
        post({ postId: 'c', publishedOn: '2026-09-22', comments: 7 }),
        // Outside the range: on no day.
        post({ postId: 'd', publishedOn: '2026-09-23', likes: 99 }),
      ],
      [],
      '2026-09-21',
      '2026-09-22',
    );
    expect(
      series.map(({ date, likes, comments, shares, engagements }) => ({
        date,
        likes,
        comments,
        shares,
        engagements,
      })),
    ).toEqual([
      {
        date: '2026-09-21',
        likes: 15,
        comments: 3,
        shares: 5,
        engagements: 23,
      },
      { date: '2026-09-22', likes: 0, comments: 7, shares: 0, engagements: 7 },
    ]);
    for (const d of series) {
      expect(d.likes + d.comments + d.shares).toBe(d.engagements);
    }
  });

  it('a followers series with a null day carries the last value and gained stays null', () => {
    const series = daySeries(
      [],
      [
        row({
          date: '2026-09-21',
          followersAtEndOfDay: 900,
          followersGained: 5,
        }),
        row({ channelId: 2, date: '2026-09-21', followersGained: -2 }),
        // The rollup wrote a row but no counts.
        row({ date: '2026-09-22' }),
        row({
          date: '2026-09-23',
          followersAtEndOfDay: 910,
          followersGained: 10,
        }),
      ],
      '2026-09-21',
      '2026-09-23',
    );
    expect(series.map((d) => [d.date, d.followers, d.followersGained])).toEqual(
      [
        ['2026-09-21', 900, 3],
        ['2026-09-22', 900, null],
        ['2026-09-23', 910, 10],
      ],
    );
  });

  it('leaves out posts outside the range', () => {
    const [day] = daySeries(
      [post({ publishedOn: '2026-09-20', likes: 9 })],
      [],
      '2026-09-21',
      '2026-09-21',
    );
    expect(day.postsPublished).toBe(0);
    expect(day.followers).toBeNull();
  });
});

describe('rangeTotals', () => {
  it('adds the days up and recomputes the rate from sums', () => {
    const days = daySeries(
      [
        post({ likes: 10, impressions: 100, reach: 80 }),
        post({ publishedOn: '2026-09-22', likes: 30, impressions: 900 }),
        post({ publishedOn: '2026-09-22', channelId: 2, likes: 60 }),
      ],
      [
        row({ date: '2026-09-21', followersGained: 4 }),
        row({ date: '2026-09-22', followersGained: -1 }),
      ],
      '2026-09-21',
      '2026-09-22',
    );
    expect(rangeTotals(days)).toEqual({
      postsPublished: 3,
      impressions: 1000,
      reach: 80,
      engagements: 100,
      // 40 rated engagements over 1000 views, not the mean of 10% and 3.3%.
      engagementRate: 4,
      followersGained: 3,
    });
  });

  it('keeps unreported metrics null, never 0', () => {
    expect(
      rangeTotals(
        daySeries([post({ likes: 3 })], [], '2026-09-21', '2026-09-21'),
      ),
    ).toEqual({
      postsPublished: 1,
      impressions: null,
      reach: null,
      engagements: 3,
      engagementRate: null,
      followersGained: null,
    });
  });
});

describe('followerTotals', () => {
  const window = {
    from: '2026-09-23',
    to: '2026-09-29',
    previousFrom: '2026-09-16',
    previousTo: '2026-09-22',
  };

  it('is the count at the end, the gain in the window, and growth from the start', () => {
    expect(
      followerTotals(
        [
          row({
            date: '2026-09-18',
            followersGained: 4,
            followersAtEndOfDay: 950,
          }),
          row({
            date: '2026-09-25',
            followersGained: 50,
            followersAtEndOfDay: 1000,
          }),
          row({
            channelId: 2,
            date: '2026-09-27',
            followersGained: null,
            followersAtEndOfDay: 100,
          }),
        ],
        window,
      ),
    ).toEqual({ value: 1100, gained: 50, growthPct: 4.8, previousGained: 4 });
  });

  it('has no growth when nothing is known', () => {
    expect(followerTotals([], window)).toEqual({
      value: null,
      gained: null,
      growthPct: null,
      previousGained: null,
    });
  });
});
