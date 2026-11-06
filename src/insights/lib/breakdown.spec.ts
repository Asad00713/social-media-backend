import { addDays, datesBetween } from '../../post-performance/period';
import type { PublishedPost } from '../../post-performance/post-performance';
import { channelBreakdown } from './breakdown';
import { lookbackStartOf } from './usual';

const post = (over: Partial<PublishedPost>): PublishedPost => ({
  postId: 'p1',
  channelId: 1,
  publishedOn: '2026-09-25',
  likes: null,
  comments: null,
  shares: null,
  impressions: null,
  publishedAt: '2026-09-25T10:00:00.000Z',
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
const window = {
  from: '2026-09-23',
  to: '2026-09-29',
  previousFrom: '2026-09-16',
  previousTo: '2026-09-22',
};
const views = (channelId: number) => ({
  channelId,
  reportsViews: true,
  isActive: true,
});
const noViews = (channelId: number) => ({
  ...views(channelId),
  reportsViews: false,
});

describe('channelBreakdown', () => {
  it('gives each channel its own totals, previous window and series', () => {
    const [ig, li] = channelBreakdown(
      [views(1), noViews(2)],
      [
        post({ postId: 'a', likes: 20, impressions: 400, reach: 300 }),
        post({
          postId: 'old',
          publishedOn: '2026-09-18',
          likes: 5,
          impressions: 100,
        }),
        // In the usual's lookback, before the previous window: not "previous".
        post({ postId: 'older', publishedOn: '2026-08-01', likes: 50 }),
        post({ postId: 'b', channelId: 2, likes: 7 }),
      ],
      [
        {
          channelId: 1,
          date: '2026-09-25',
          followersAtEndOfDay: 500,
          followersGained: 10,
        },
      ],
      window,
    );
    expect(ig).toMatchObject({
      channelId: 1,
      postsPublished: 1,
      impressions: 400,
      reach: 300,
      engagements: 20,
      engagementRate: 5,
      followers: 500,
      followersGained: 10,
      previous: {
        postsPublished: 1,
        impressions: 100,
        engagements: 5,
        followersGained: null,
      },
    });
    expect(ig.series).toHaveLength(7);
    expect(ig.series.map((d) => d.date)).toEqual(
      datesBetween(window.from, window.to),
    );
    expect(li).toMatchObject({
      channelId: 2,
      postsPublished: 1,
      impressions: null,
      reach: null,
      engagementRate: null,
      followers: null,
    });
  });

  it('lists a channel with nothing in the window at zero', () => {
    const [c] = channelBreakdown([views(3)], [], [], window);
    expect(c.postsPublished).toBe(0);
    expect(c.series.every((d) => d.postsPublished === 0)).toBe(true);
    expect(c.vsUsual).toEqual({
      metric: 'engagements',
      deltaPct: null,
      tone: null,
    });
  });

  describe('vsUsual', () => {
    // One post a day through the whole lookback: 10 likes and 100 views
    // each, so the usual 7 days are 70 engagements and 700 views.
    const lookback = datesBetween(
      lookbackStartOf(window.from, 7),
      addDays(window.from, -1),
    );
    const history = (
      channelId: number,
      impressions: number | null,
    ): PublishedPost[] =>
      lookback.map((d) =>
        post({
          postId: `${channelId}-${d}`,
          channelId,
          publishedOn: d,
          likes: 10,
          impressions,
        }),
      );
    const inWindow = (
      channelId: number,
      likes: number[],
      impressions: number | null,
    ): PublishedPost[] =>
      likes.map((l, i) =>
        post({
          postId: `${channelId}-w${i}`,
          channelId,
          publishedOn: addDays(window.from, i),
          likes: l,
          impressions,
        }),
      );

    it('channel vsUsual uses views when reported, else engagements', () => {
      const [withViews, noViewData, notReported] = channelBreakdown(
        [views(1), views(2), noViews(3)],
        [
          ...history(1, 100),
          ...inWindow(1, [10, 10, 10, 10, 10, 10, 10], 110),
          // The platform says it reports views, but none arrived (e.g. no
          // App Review yet): engagements, so the badge still means something.
          ...history(2, null),
          ...inWindow(2, [20, 20, 20, 20, 20, 20, 20], null),
          // Views in the data from a platform that says it shares none: the
          // table shows "Not shared", so the badge must not be on views.
          ...history(3, 100),
          ...inWindow(3, [5, 5, 5, 5, 5, 5, 5], 500),
        ],
        [],
        window,
      );
      // 770 views against 700.
      expect(withViews.vsUsual).toEqual({
        metric: 'impressions',
        deltaPct: 10,
        tone: 'up',
      });
      // 140 engagements against 70.
      expect(noViewData.vsUsual).toEqual({
        metric: 'engagements',
        deltaPct: 100,
        tone: 'up',
      });
      // 35 engagements against 70.
      expect(notReported.vsUsual).toEqual({
        metric: 'engagements',
        deltaPct: -50,
        tone: 'down',
      });
    });

    it('channel vsUsual tone is flat under 5%', () => {
      const [c] = channelBreakdown(
        [views(1)],
        // 73 engagements against 70: +4.3%.
        [
          ...history(1, null),
          ...inWindow(1, [13, 10, 10, 10, 10, 10, 10], null),
        ],
        [],
        window,
      );
      expect(c.vsUsual).toEqual({
        metric: 'engagements',
        deltaPct: 4.3,
        tone: 'flat',
      });
    });

    it('is against the usual, never a channel with too little history', () => {
      const [c] = channelBreakdown(
        [views(1)],
        [
          ...history(1, 100).slice(-9),
          ...inWindow(1, [10, 10, 10, 10, 10, 10, 10], 110),
        ],
        [],
        window,
      );
      expect(c.vsUsual).toEqual({
        metric: 'impressions',
        deltaPct: null,
        tone: null,
      });
    });

    it('a paused channel with nothing in the window has no delta; an active one is down', () => {
      // A full usual on engagements, then nothing in the window: 0 against 70.
      const [paused, active] = channelBreakdown(
        [{ ...views(1), isActive: false }, views(2)],
        [...history(1, null), ...history(2, null)],
        [],
        window,
      );
      // Numbers after a pause are missing, not zero.
      expect(paused.vsUsual).toEqual({
        metric: 'engagements',
        deltaPct: null,
        tone: null,
      });
      // An active channel that posted nothing really is below its usual.
      expect(active.vsUsual).toEqual({
        metric: 'engagements',
        deltaPct: -100,
        tone: 'down',
      });
    });

    it('a paused channel that posted in the window keeps its delta', () => {
      const [c] = channelBreakdown(
        [{ ...views(1), isActive: false }],
        [...history(1, 100), ...inWindow(1, [10, 10, 10], 110)],
        [],
        window,
      );
      // 330 views against 700.
      expect(c.vsUsual).toEqual({
        metric: 'impressions',
        deltaPct: -52.9,
        tone: 'down',
      });
    });
  });
});
