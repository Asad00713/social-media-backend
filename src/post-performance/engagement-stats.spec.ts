import type { PublishedPost } from './post-performance';
import {
  MIN_POSTS_FOR_USUAL,
  isMeasured,
  median,
  usualMultiplier,
} from './engagement-stats';

const post = (over: Partial<PublishedPost> = {}): PublishedPost => ({
  postId: 'p',
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

describe('median', () => {
  it('is null for no values', () => expect(median([])).toBeNull());
  it('sorts before picking the middle', () =>
    expect(median([1, 3, 2])).toBe(2));
  it('averages the two middle values for an even count', () =>
    expect(median([1, 2, 3, 4])).toBe(2.5));
  it('does not mutate its input', () => {
    const v = [3, 1, 2];
    median(v);
    expect(v).toEqual([3, 1, 2]);
  });
});

describe('usualMultiplier', () => {
  it('needs at least 5 samples', () => {
    expect(MIN_POSTS_FOR_USUAL).toBe(5);
    expect(usualMultiplier(10, [5, 5, 5, 5])).toBeNull();
  });
  it('is engagements over the median, to 2 decimals', () => {
    expect(usualMultiplier(10, [4, 5, 5, 5, 6])).toBe(2);
    expect(usualMultiplier(10, [3, 3, 3, 3, 3])).toBe(3.33);
  });
  it('is null when the median is 0', () => {
    expect(usualMultiplier(10, [0, 0, 0, 1, 9])).toBeNull();
  });
});

describe('isMeasured', () => {
  it('is false when nothing was reported', () =>
    expect(isMeasured(post())).toBe(false));
  it.each(['likes', 'comments', 'shares', 'impressions'] as const)(
    'is true once %s is reported, even as 0',
    (k) => expect(isMeasured(post({ [k]: 0 }))).toBe(true),
  );
});
