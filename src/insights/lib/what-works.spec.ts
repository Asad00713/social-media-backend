import type { InsightFormat, InsightPost } from './insight-post';
import { formatBars, topicBars } from './what-works';

let seq = 0;
const post = (
  format: InsightFormat,
  engagements: number,
  over: Partial<InsightPost> = {},
): InsightPost => ({
  postId: `p${++seq}`,
  channelId: 1,
  publishedAt: '2026-10-15T14:00:00.000Z',
  title: '',
  content: '',
  format,
  thumbnailUrl: null,
  permalink: null,
  likes: engagements,
  comments: 0,
  shares: 0,
  impressions: null,
  reach: null,
  engagements,
  engagementRate: null,
  imported: false,
  usualMultiplier: null,
  isSettling: false,
  ...over,
});

describe('formatBars', () => {
  it('format median: one viral post does not move it', () => {
    const bars = formatBars([
      post('video', 10),
      post('video', 12),
      post('video', 14),
      post('video', 90_000),
      post('image', 20),
      post('image', 21),
      post('image', 22),
    ]);
    expect(bars).toEqual([
      { key: 'image', posts: 3, median: 21 },
      { key: 'video', posts: 4, median: 13 },
    ]);
  });

  it('format with 2 posts gets no bar; unknown gets no bar', () => {
    const bars = formatBars([
      post('carousel', 500),
      post('carousel', 600),
      post('unknown', 50),
      post('unknown', 50),
      post('unknown', 50),
      post('text', 1),
      post('text', 2),
      post('text', 3),
    ]);
    expect(bars).toEqual([{ key: 'text', posts: 3, median: 2 }]);
  });

  it('an unmeasured post is not counted; a tie goes to more posts', () => {
    const unmeasured = post('link', 0, {
      likes: null,
      comments: null,
      shares: null,
    });
    const bars = formatBars([
      post('link', 5),
      post('link', 5),
      post('link', 5),
      unmeasured,
      unmeasured,
      post('image', 5),
      post('image', 5),
      post('image', 5),
      post('image', 5),
    ]);
    expect(bars).toEqual([
      { key: 'image', posts: 4, median: 5 },
      { key: 'link', posts: 3, median: 5 },
    ]);
  });
});

describe('topicBars', () => {
  it('topic: a post with two tags counts under both; soft-deleted item keeps its tags', () => {
    // The tags arrive from the repository, which reads a soft-deleted media
    // item's tags as well (its DB spec proves it); here every tag counts.
    const a = post('image', 10);
    const b = post('image', 20);
    const c = post('image', 30);
    const d = post('video', 40);
    const tags = new Map([
      [a.postId, ['food', 'travel']],
      [b.postId, ['food', 'travel', ' food ']],
      [c.postId, ['food']],
      [d.postId, ['travel']],
    ]);
    expect(topicBars([a, b, c, d], tags)).toEqual({
      // Same median and count: by name.
      bars: [
        { key: 'food', posts: 3, median: 20 },
        { key: 'travel', posts: 3, median: 20 },
      ],
      untaggedPosts: 0,
      hasAnyTag: true,
    });
  });

  it('topic: untagged count and hasAnyTag false', () => {
    const posts = [post('image', 1), post('text', 2), post('link', 3)];
    expect(topicBars(posts, new Map([[posts[0].postId, ['  ', '']]]))).toEqual({
      bars: [],
      untaggedPosts: 3,
      hasAnyTag: false,
    });
  });

  it('keeps at most 4 tags with 3 posts each, by median; a thin tag still makes hasAnyTag true', () => {
    const posts: InsightPost[] = [];
    const tags = new Map<string, string[]>();
    for (const [tag, value] of [
      ['a', 1],
      ['b', 5],
      ['c', 3],
      ['d', 4],
      ['e', 2],
    ] as const) {
      for (let i = 0; i < 3; i++) {
        const p = post('image', value);
        posts.push(p);
        tags.set(p.postId, [tag]);
      }
    }
    const thin = post('image', 99);
    tags.set(thin.postId, ['rare']);
    const untagged = post('image', 7);
    const result = topicBars([...posts, thin, untagged], tags);
    expect(result.bars.map((b) => b.key)).toEqual(['b', 'd', 'c', 'e']);
    expect(result.untaggedPosts).toBe(1);

    const onlyThin = topicBars([thin, untagged], tags);
    expect(onlyThin).toEqual({ bars: [], untaggedPosts: 1, hasAnyTag: true });
  });
});
