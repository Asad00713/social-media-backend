import type { PublishedPost } from '../../post-performance/post-performance';
import { multiplierOf, usualByChannel } from './usual-multiplier';

const post = (over: Partial<PublishedPost>): PublishedPost => ({
  postId: 'p1',
  channelId: 1,
  publishedOn: '2026-09-20',
  likes: null,
  comments: null,
  shares: null,
  impressions: null,
  reach: null,
  saved: null,
  follows: null,
  syncedAt: null,
  publishedAt: '2026-09-20T10:00:00.000Z',
  content: '',
  mediaItems: [],
  imported: false,
  permalink: null,
  mediaType: null,
  ...over,
});

const engaged = (channelId: number, likes: number) =>
  post({ channelId, likes, comments: 0, shares: 0 });

describe('usualByChannel', () => {
  it("groups each channel's measured engagements and skips unmeasured posts", () => {
    const usual = usualByChannel([
      engaged(1, 4),
      engaged(2, 9),
      engaged(1, 6),
      post({ channelId: 1 }),
      // Views alone count as measured, with 0 engagements.
      post({ channelId: 2, impressions: 300 }),
    ]);
    expect(usual).toEqual(
      new Map([
        [1, [4, 6]],
        [2, [9, 0]],
      ]),
    );
  });

  it('is empty for an empty sample', () => {
    expect(usualByChannel([]).size).toBe(0);
  });
});

describe('multiplierOf', () => {
  const usual = usualByChannel(
    [4, 5, 5, 5, 6].map((e) => engaged(1, e)).concat(engaged(2, 3)),
  );

  it("is the post's engagements over its channel's median", () => {
    expect(multiplierOf(engaged(1, 10), usual)).toBe(2);
    expect(
      multiplierOf(post({ likes: 3, comments: 1, shares: 1 }), usual),
    ).toBe(1);
  });

  it('is null when the post is not measured', () => {
    expect(multiplierOf(post({}), usual)).toBeNull();
  });

  it('is null below 5 measured posts, or for a channel with no sample', () => {
    expect(multiplierOf(engaged(2, 6), usual)).toBeNull();
    expect(multiplierOf(engaged(7, 6), usual)).toBeNull();
  });

  it('is null when the median is 0', () => {
    const zero = usualByChannel([0, 0, 0, 0, 0].map((e) => engaged(1, e)));
    expect(multiplierOf(engaged(1, 5), zero)).toBeNull();
  });
});
