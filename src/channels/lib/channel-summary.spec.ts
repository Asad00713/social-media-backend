import {
  FOLLOWER_SERIES_DAYS,
  INBOX_PLATFORMS,
  followersChangePct,
  laterOf,
  mergeFollowerSeries,
  thumbnailFor,
} from './channel-summary';
import { INTEGRATION_PLATFORMS } from '../../drizzle/schema/channels.schema';

describe('mergeFollowerSeries', () => {
  it('prefers the daily rollup, fills gaps from snapshots, oldest first', () => {
    const series = mergeFollowerSeries(
      [
        { date: '2026-11-03', value: 120 },
        { date: '2026-11-01', value: 100 },
        { date: '2026-11-02', value: null },
      ],
      [
        { date: '2026-11-01', value: 99 },
        { date: '2026-11-02', value: 110 },
        { date: new Date('2026-11-04T00:00:00Z'), value: 130 },
      ],
    );
    expect(series).toEqual([
      { date: '2026-11-01', value: 100 },
      { date: '2026-11-02', value: 110 },
      { date: '2026-11-03', value: 120 },
      { date: '2026-11-04', value: 130 },
    ]);
  });

  it('keeps only the latest 30 days', () => {
    const daily = Array.from({ length: 40 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10),
      value: i,
    }));
    const series = mergeFollowerSeries(daily, []);
    expect(series).toHaveLength(FOLLOWER_SERIES_DAYS);
    expect(series[0].value).toBe(10);
    expect(series.at(-1)?.value).toBe(39);
  });

  it('is empty with no numbers at all', () => {
    expect(
      mergeFollowerSeries([], [{ date: '2026-11-01', value: null }]),
    ).toEqual([]);
  });
});

describe('followersChangePct', () => {
  it('first to last, one decimal', () => {
    expect(
      followersChangePct([
        { date: 'a', value: 300 },
        { date: 'b', value: 250 },
        { date: 'c', value: 310 },
      ]),
    ).toBe(3.3);
    expect(
      followersChangePct([
        { date: 'a', value: 200 },
        { date: 'b', value: 150 },
      ]),
    ).toBe(-25);
  });

  it('null with fewer than two points or a zero start', () => {
    expect(followersChangePct([])).toBeNull();
    expect(followersChangePct([{ date: 'a', value: 5 }])).toBeNull();
    expect(
      followersChangePct([
        { date: 'a', value: 0 },
        { date: 'b', value: 5 },
      ]),
    ).toBeNull();
  });
});

describe('thumbnailFor', () => {
  const post = {
    content: 'x',
    mediaItems: [{ url: 'https://cdn/shared.jpg', type: 'image' as const }],
    platformContent: {
      instagram: {
        overrides: {
          mediaItems: [
            {
              url: 'https://cdn/ig.mp4',
              type: 'video' as const,
              thumbnailUrl: 'https://cdn/ig-poster.jpg',
            },
          ],
        },
      },
    },
  };

  it("uses the channel's own media, then the shared media", () => {
    expect(thumbnailFor(post, { platform: 'instagram' })).toBe(
      'https://cdn/ig-poster.jpg',
    );
    expect(thumbnailFor(post, { platform: 'threads' })).toBe(
      'https://cdn/shared.jpg',
    );
  });

  it('a target override wins; a video without a poster has no picture', () => {
    expect(
      thumbnailFor(post, {
        platform: 'threads',
        contentOverride: {
          mediaItems: [{ url: 'https://cdn/v.mp4', type: 'video' }],
        },
      }),
    ).toBeNull();
    expect(
      thumbnailFor({ content: 'text only' }, { platform: 'x' }),
    ).toBeNull();
  });
});

describe('laterOf', () => {
  it('picks the later instant, tolerating missing ones', () => {
    const a = new Date('2026-11-01T00:00:00Z');
    const b = '2026-11-02T00:00:00.000Z';
    expect(laterOf(a, b)?.toISOString()).toBe(b);
    expect(laterOf(a, null)).toEqual(a);
    expect(laterOf(null, undefined)).toBeNull();
  });
});

describe('INBOX_PLATFORMS', () => {
  it('holds no integration', () => {
    for (const p of INTEGRATION_PLATFORMS) {
      expect(INBOX_PLATFORMS.has(p)).toBe(false);
    }
  });
});
