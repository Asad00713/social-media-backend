import type { PublishedPost } from '../../post-performance/post-performance';
import { channelBreakdown } from './breakdown';

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
  ...over,
});
const window = {
  from: '2026-09-23',
  to: '2026-09-29',
  previousFrom: '2026-09-16',
  previousTo: '2026-09-22',
};

describe('channelBreakdown', () => {
  it('gives each channel its own totals, previous window and series', () => {
    const [ig, li] = channelBreakdown(
      [1, 2],
      [
        post({ postId: 'a', likes: 20, impressions: 400 }),
        post({
          postId: 'old',
          publishedOn: '2026-09-18',
          likes: 5,
          impressions: 100,
        }),
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
    expect(li).toMatchObject({
      channelId: 2,
      postsPublished: 1,
      impressions: null,
      engagementRate: null,
      followers: null,
    });
  });

  it('lists a channel with nothing in the window at zero', () => {
    const [c] = channelBreakdown([3], [], [], window);
    expect(c.postsPublished).toBe(0);
    expect(c.series.every((d) => d.postsPublished === 0)).toBe(true);
  });
});
