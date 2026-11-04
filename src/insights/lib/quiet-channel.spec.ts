import { addDays } from '../../post-performance/period';
import type { PublishedPost } from '../../post-performance/post-performance';
import { cadenceOf, quietChannel, type QuietInput } from './quiet-channel';

const TODAY = new Date('2026-11-04T09:00:00.000Z');

const post = (publishedOn: string): PublishedPost => ({
  postId: `p-${publishedOn}`,
  channelId: 1,
  publishedOn,
  likes: 1,
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

/** `count` posts `gap` days apart, the newest `ago` days before TODAY. */
function every(gap: number, ago: number, count: number): PublishedPost[] {
  return Array.from({ length: count }, (_, i) =>
    post(addDays('2026-11-04', -(ago + i * gap))),
  );
}

const input = (over: Partial<QuietInput> = {}): QuietInput => ({
  channelId: 1,
  posts: every(7, 30, 5),
  isActive: true,
  healthy: true,
  today: TODAY,
  ...over,
});

describe('quietChannel', () => {
  it('finds a channel quiet past twice its median gap', () => {
    expect(quietChannel([input()])).toEqual({
      channelId: 1,
      lastPostOn: '2026-10-05',
      daysQuiet: 30,
      medianGapDays: 7,
      cadence: 'weekly',
    });
  });

  it('a channel with a post yesterday is not quiet', () => {
    expect(quietChannel([input({ posts: every(7, 1, 5) })])).toBeNull();
  });

  it('is not quiet before 14 days, even for a daily poster', () => {
    expect(quietChannel([input({ posts: every(1, 13, 8) })])).toBeNull();
    expect(quietChannel([input({ posts: every(1, 14, 8) })])?.cadence).toBe(
      'almost daily',
    );
  });

  it('needs twice the median gap when that is over 7 days', () => {
    // Gap 12: threshold 24.
    expect(quietChannel([input({ posts: every(12, 23, 4) })])).toBeNull();
    expect(quietChannel([input({ posts: every(12, 24, 4) })])).not.toBeNull();
  });

  it('a paused or unhealthy channel is not quiet', () => {
    expect(quietChannel([input({ isActive: false })])).toBeNull();
    expect(quietChannel([input({ healthy: false })])).toBeNull();
  });

  it('needs 3 posts on at least 2 days in the 90 days', () => {
    expect(quietChannel([input({ posts: every(7, 30, 2) })])).toBeNull();
    // Three posts on one day: no cadence to be late against.
    const sameDay = [
      post('2026-10-01'),
      post('2026-10-01'),
      post('2026-10-01'),
    ];
    expect(quietChannel([input({ posts: sameDay })])).toBeNull();
    // A post older than 90 days does not count.
    expect(
      quietChannel([
        input({ posts: [...every(7, 30, 2), post('2026-06-01')] }),
      ]),
    ).toBeNull();
  });

  it('picks the most overdue channel, whatever the order', () => {
    const slight = input({ channelId: 1, posts: every(7, 20, 5) });
    const worse = input({ channelId: 2, posts: every(7, 40, 5) });
    expect(quietChannel([slight, worse])?.channelId).toBe(2);
    expect(quietChannel([worse, slight])?.channelId).toBe(2);
  });

  it('is null for no channels', () => {
    expect(quietChannel([])).toBeNull();
  });
});

describe('cadenceOf', () => {
  it.each([
    [1, 'almost daily'],
    [2, 'almost daily'],
    [2.5, 'weekly'],
    [9, 'weekly'],
    [10, 'every two weeks'],
    [16, 'every two weeks'],
    [17, 'about monthly'],
  ])('%s days is %s', (gap, label) => {
    expect(cadenceOf(gap)).toBe(label);
  });
});
