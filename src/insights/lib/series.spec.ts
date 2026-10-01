import type { FollowerRow } from '../../post-performance/followers';
import type { PublishedPost } from '../../post-performance/post-performance';
import { daySeries, followerTotals } from './series';

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
        post({ postId: 'a', likes: 10, impressions: 500 }),
        post({ postId: 'b', channelId: 2, likes: 30 }), // reports no impressions
      ],
      [row({ date: '2026-09-21', followersAtEndOfDay: 900 })],
      '2026-09-21',
      '2026-09-22',
    );
    expect(series).toEqual([
      {
        date: '2026-09-21',
        postsPublished: 2,
        impressions: 500,
        engagements: 40,
        ratedEngagements: 10,
        followers: 900,
      },
      // Nothing posted: zeros, and followers carried forward.
      {
        date: '2026-09-22',
        postsPublished: 0,
        impressions: null,
        engagements: 0,
        ratedEngagements: 0,
        followers: 900,
      },
    ]);
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
