import type { PublishedPost } from '../../post-performance/post-performance';
import { DAILY_CSV_HEADER, dailyCsv, dayEngagementRate } from './daily-csv';
import { daySeries } from './series';

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

describe('dailyCsv', () => {
  it('writes one row per day, oldest first, empty cells for unreported metrics', () => {
    const days = daySeries(
      [
        post({ likes: 8, comments: 2, impressions: 200, reach: 150 }),
        // Reports no impressions: counts in engagements, not in the rate.
        post({ postId: 'b', likes: 10 }),
      ],
      [
        {
          channelId: 1,
          date: '2026-09-21',
          followersAtEndOfDay: 500,
          followersGained: 4,
        },
      ],
      '2026-09-21',
      '2026-09-22',
    );
    const body = dailyCsv(days);
    expect(body.startsWith('\uFEFF')).toBe(true);
    const lines = body.slice(1).split('\r\n');
    expect(lines).toEqual([
      DAILY_CSV_HEADER.join(','),
      '2026-09-21,2,200,150,20,5,18,2,0,500,4',
      '2026-09-22,0,,,0,,0,0,0,500,',
      '',
    ]);
  });

  it('the day rate is rated engagements over impressions', () => {
    const [d] = daySeries(
      [post({ likes: 1, impressions: 3 })],
      [],
      '2026-09-21',
      '2026-09-21',
    );
    expect(dayEngagementRate(d)).toBe(33.3);
  });
});
