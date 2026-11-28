import { wallClockToUtc } from '../../common/utils/wall-clock';
import type { PublishedPost } from '../../post-performance/post-performance';
import {
  computeStreakWeeks,
  dailySeries,
  deltaPct,
  followersGainedOf,
  isPulseRange,
  summarizeChannel,
  weekStart,
  localDateOf,
  splitWeekPosts,
  weekWindowOf,
  type FollowerRow,
} from './home-summary';

const row = (over: Partial<FollowerRow>): FollowerRow => ({
  channelId: 1,
  date: '2026-09-20',
  followersAtEndOfDay: null,
  followersGained: null,
  ...over,
});

const post = (over: Partial<PublishedPost>): PublishedPost => ({
  postId: 'p1',
  channelId: 1,
  publishedOn: '2026-09-20',
  likes: null,
  comments: null,
  shares: null,
  impressions: null,
  publishedAt: '2026-09-20T10:00:00.000Z',
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

describe('deltaPct', () => {
  it('is the percentage change, one decimal', () => {
    expect(deltaPct(12, 10)).toBe(20);
    expect(deltaPct(326, 340)).toBe(-4.1);
  });
  it('is null when there is nothing to compare against', () => {
    expect(deltaPct(5, 0)).toBeNull();
    expect(deltaPct(5, null)).toBeNull();
    expect(deltaPct(null, 5)).toBeNull();
  });
});

describe('followersGainedOf', () => {
  it('adds the daily gains across channels, losses included', () => {
    expect(
      followersGainedOf([
        row({ channelId: 1, followersGained: 5 }),
        row({ channelId: 2, followersGained: -2 }),
        row({ channelId: 2, date: '2026-09-21', followersGained: 4 }),
      ]),
    ).toBe(7);
  });

  it('is null, not zero, when no channel reported a change', () => {
    expect(followersGainedOf([row({})])).toBeNull();
    expect(followersGainedOf([])).toBeNull();
  });
});

describe('summarizeChannel', () => {
  it('takes the latest follower count and computes growth over the window', () => {
    const c = summarizeChannel(
      7,
      [
        row({
          channelId: 7,
          date: '2026-09-21',
          followersAtEndOfDay: 1000,
          followersGained: 10,
        }),
        row({
          channelId: 7,
          date: '2026-09-23',
          followersAtEndOfDay: 1030,
          followersGained: 20,
        }),
      ],
      3,
    );
    expect(c).toEqual({
      channelId: 7,
      followers: 1030,
      followersGained: 30,
      growthPct: 3,
      postsThisWeek: 3,
    });
  });

  it('has no growth when the starting count is unknown or zero', () => {
    expect(summarizeChannel(7, [], 0).growthPct).toBeNull();
    expect(
      summarizeChannel(
        7,
        [row({ channelId: 7, followersAtEndOfDay: 5, followersGained: 5 })],
        0,
      ).growthPct,
    ).toBeNull();
  });
});

describe('weekStart', () => {
  it('is Monday 00:00 UTC of the week', () => {
    expect(weekStart(new Date('2026-09-28T10:00:00Z')).toISOString()).toBe(
      '2026-09-28T00:00:00.000Z',
    );
    expect(weekStart(new Date('2026-09-27T23:00:00Z')).toISOString()).toBe(
      '2026-09-21T00:00:00.000Z',
    );
  });
});

describe('weekWindowOf', () => {
  it('spans Monday to today, against the same days last week', () => {
    expect(weekWindowOf(new Date('2026-11-27T13:48:00Z'))).toEqual({
      from: '2026-11-23',
      to: '2026-11-27',
      previousFrom: '2026-11-16',
      previousTo: '2026-11-20',
    });
  });

  it('is one day on a Monday', () => {
    expect(weekWindowOf(new Date('2026-11-23T09:00:00Z'))).toMatchObject({
      from: '2026-11-23',
      to: '2026-11-23',
      previousFrom: '2026-11-16',
      previousTo: '2026-11-16',
    });
  });

  it('is the whole week on a Sunday', () => {
    expect(weekWindowOf(new Date('2026-11-29T23:59:00Z'))).toEqual({
      from: '2026-11-23',
      to: '2026-11-29',
      previousFrom: '2026-11-16',
      previousTo: '2026-11-22',
    });
  });

  describe('with a week start', () => {
    // 2026-11-28 is a Saturday; 11-22 and 11-29 are Sundays.
    it('starts on the Sunday before a Saturday', () => {
      expect(weekWindowOf(new Date('2026-11-28T10:00:00Z'), 'sunday')).toEqual({
        from: '2026-11-22',
        to: '2026-11-28',
        previousFrom: '2026-11-15',
        previousTo: '2026-11-21',
      });
    });

    it('is one day on a Sunday, for a Sunday start', () => {
      expect(weekWindowOf(new Date('2026-11-29T01:00:00Z'), 'sunday')).toEqual({
        from: '2026-11-29',
        to: '2026-11-29',
        previousFrom: '2026-11-22',
        previousTo: '2026-11-22',
      });
    });

    it('is one day on a Saturday, for a Saturday start', () => {
      expect(
        weekWindowOf(new Date('2026-11-28T10:00:00Z'), 'saturday'),
      ).toEqual({
        from: '2026-11-28',
        to: '2026-11-28',
        previousFrom: '2026-11-21',
        previousTo: '2026-11-21',
      });
    });

    it('starts on the Saturday before a Friday, for a Saturday start', () => {
      expect(
        weekWindowOf(new Date('2026-11-27T23:00:00Z'), 'saturday'),
      ).toEqual({
        from: '2026-11-21',
        to: '2026-11-27',
        previousFrom: '2026-11-14',
        previousTo: '2026-11-20',
      });
    });

    it('stays Monday-based when asked for monday', () => {
      expect(weekWindowOf(new Date('2026-11-27T13:48:00Z'), 'monday')).toEqual(
        weekWindowOf(new Date('2026-11-27T13:48:00Z')),
      );
    });
  });

  describe('in a time zone', () => {
    it('uses the local date: Monday 02:00 in Karachi is still Sunday in UTC', () => {
      // 2026-11-29T21:00Z = Mon 2026-11-30 02:00 PKT (UTC+5, no DST).
      const now = new Date('2026-11-29T21:00:00Z');
      expect(weekWindowOf(now, 'monday', 'Asia/Karachi')).toEqual({
        from: '2026-11-30',
        to: '2026-11-30',
        previousFrom: '2026-11-23',
        previousTo: '2026-11-23',
      });
      // The same moment in UTC is the last day of the old week.
      expect(weekWindowOf(now)).toEqual({
        from: '2026-11-23',
        to: '2026-11-29',
        previousFrom: '2026-11-16',
        previousTo: '2026-11-22',
      });
    });

    it('combines with a Sunday start: Karachi Monday is the second day', () => {
      expect(
        weekWindowOf(
          new Date('2026-11-29T21:00:00Z'),
          'sunday',
          'Asia/Karachi',
        ),
      ).toEqual({
        from: '2026-11-29',
        to: '2026-11-30',
        previousFrom: '2026-11-22',
        previousTo: '2026-11-23',
      });
    });

    it('uses the local date west of UTC: Sunday 21:00 in New York is Monday in UTC', () => {
      // 2026-11-30T02:00Z = Sun 2026-11-29 21:00 EST (UTC-5).
      const now = new Date('2026-11-30T02:00:00Z');
      expect(weekWindowOf(now, 'monday', 'America/New_York')).toEqual({
        from: '2026-11-23',
        to: '2026-11-29',
        previousFrom: '2026-11-16',
        previousTo: '2026-11-22',
      });
      expect(weekWindowOf(now).from).toBe('2026-11-30');
    });

    it('UTC given explicitly is the same as no zone', () => {
      const now = new Date('2026-11-27T13:48:00Z');
      expect(weekWindowOf(now, 'monday', 'UTC')).toEqual(weekWindowOf(now));
    });
  });
});

describe('localDateOf', () => {
  it('is the calendar date of an instant in a zone', () => {
    expect(localDateOf(new Date('2026-11-29T19:00:00Z'), 'Asia/Karachi')).toBe(
      '2026-11-30',
    );
    expect(localDateOf(new Date('2026-11-29T18:59:59Z'), 'Asia/Karachi')).toBe(
      '2026-11-29',
    );
    expect(
      localDateOf(new Date('2026-11-23T04:59:59Z'), 'America/New_York'),
    ).toBe('2026-11-22');
  });
});

describe('computeStreakWeeks', () => {
  const now = new Date('2026-09-30T12:00:00Z'); // Wednesday
  const d = (s: string) => new Date(s);

  it('counts consecutive weeks including this one', () => {
    expect(
      computeStreakWeeks(
        [
          d('2026-09-29T09:00Z'),
          d('2026-09-22T09:00Z'),
          d('2026-09-15T09:00Z'),
        ],
        now,
      ),
    ).toBe(3);
  });

  it("keeps last week's streak alive when nothing is published yet this week", () => {
    expect(
      computeStreakWeeks([d('2026-09-22T09:00Z'), d('2026-09-16T09:00Z')], now),
    ).toBe(2);
  });

  it('stops at the first empty week', () => {
    expect(
      computeStreakWeeks([d('2026-09-29T09:00Z'), d('2026-09-08T09:00Z')], now),
    ).toBe(1);
  });

  it('is zero when the last two weeks are empty', () => {
    expect(computeStreakWeeks([d('2026-09-08T09:00Z')], now)).toBe(0);
    expect(computeStreakWeeks([], now)).toBe(0);
  });
});

describe('dailySeries', () => {
  it('puts each post on the day it went out, summed across channels', () => {
    const series = dailySeries(
      [
        post({
          postId: 'a',
          publishedOn: '2026-09-21',
          likes: 5,
          comments: 1,
          impressions: 100,
        }),
        post({
          postId: 'b',
          channelId: 2,
          publishedOn: '2026-09-21',
          shares: 4,
          impressions: 50,
        }),
        post({ postId: 'c', publishedOn: '2026-09-23', likes: 2 }),
      ],
      [row({ date: '2026-09-21', followersGained: 3 })],
      '2026-09-21',
      '2026-09-23',
    );
    expect(series).toEqual([
      {
        date: '2026-09-21',
        postsPublished: 2,
        impressions: 150,
        engagements: 10,
        followersGained: 3,
      },
      // A day with nothing at all is still on the line, at zero.
      {
        date: '2026-09-22',
        postsPublished: 0,
        impressions: null,
        engagements: 0,
        followersGained: null,
      },
      {
        date: '2026-09-23',
        postsPublished: 1,
        impressions: null,
        engagements: 2,
        followersGained: null,
      },
    ]);
  });

  it('leaves out posts and follower days outside the window', () => {
    const series = dailySeries(
      [post({ publishedOn: '2026-09-20', likes: 9 })],
      [row({ date: '2026-09-20', followersGained: 9 })],
      '2026-09-21',
      '2026-09-21',
    );
    expect(series).toEqual([
      {
        date: '2026-09-21',
        postsPublished: 0,
        impressions: null,
        engagements: 0,
        followersGained: null,
      },
    ]);
  });

  it('crosses a month end', () => {
    expect(
      dailySeries([], [], '2026-09-29', '2026-10-02').map((d) => d.date),
    ).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  });
});

describe('isPulseRange', () => {
  it('accepts 7, 30 and 90 days only', () => {
    expect([7, 30, 90].every(isPulseRange)).toBe(true);
    expect([0, 1, 14, 31, 365, NaN].some(isPulseRange)).toBe(false);
  });
});

describe('weekWindowOf never starts before the read', () => {
  // The Home read starts at UTC midnight 14 days before today (UTC) and the
  // summary relies on the local window never reaching back past it. Walk every
  // hour of three weeks (crossing both 2026 DST changes of the northern
  // zones used) through zones from UTC-12 to UTC+14, for each week start.
  const zones = [
    'Etc/GMT+12',
    'Pacific/Pago_Pago',
    'America/Los_Angeles',
    'America/New_York',
    'UTC',
    'Europe/Paris',
    'Asia/Karachi',
    'Asia/Kolkata',
    'Australia/Lord_Howe',
    'Pacific/Auckland',
    'Pacific/Kiritimati',
  ];
  const starts = ['monday', 'sunday', 'saturday'] as const;
  const HOUR = 60 * 60 * 1000;
  const from = Date.parse('2026-10-20T00:00:00Z');
  const hours = (21 * 24 * HOUR) / HOUR;

  it.each(zones)(
    '%s: the previous week begins at or after the read start',
    (zone) => {
      for (const weekStartDay of starts) {
        for (let h = 0; h < hours; h++) {
          const now = new Date(from + h * HOUR);
          const w = weekWindowOf(now, weekStartDay, zone);
          const readStart = new Date(
            Date.UTC(
              now.getUTCFullYear(),
              now.getUTCMonth(),
              now.getUTCDate() - 14,
            ),
          );
          const begins = wallClockToUtc(w.previousFrom, '00:00', zone);
          expect(begins).not.toBeNull();
          if (begins!.getTime() < readStart.getTime()) {
            throw new Error(
              `${zone} ${weekStartDay} at ${now.toISOString()}: previous week begins ${begins!.toISOString()}, before the read at ${readStart.toISOString()}`,
            );
          }
        }
      }
    },
  );
});

describe('splitWeekPosts', () => {
  const at = (id: string, publishedAt: string) => ({ id, publishedAt });
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

  it('cuts at the UTC instants of local midnight (Karachi, UTC+5)', () => {
    // Window: this week Nov 30 (Mon), last Monday Nov 23. Local midnights:
    //   Nov 22 00:00 PKT = 11-21T19:00Z   (not in either; the day before)
    //   Nov 23 00:00 PKT = 11-22T19:00Z   previous starts
    //   Nov 24 00:00 PKT = 11-23T19:00Z   previous ends (exclusive)
    //   Nov 30 00:00 PKT = 11-29T19:00Z   current starts
    //   Dec 01 00:00 PKT = 11-30T19:00Z   current ends (exclusive)
    const window = {
      from: '2026-11-30',
      to: '2026-11-30',
      previousFrom: '2026-11-23',
      previousTo: '2026-11-23',
    };
    const posts = [
      at('before-prev', '2026-11-22T18:59:59.999Z'),
      at('prev-first', '2026-11-22T19:00:00.000Z'),
      at('prev-last', '2026-11-23T18:59:59.999Z'),
      at('gap', '2026-11-23T19:00:00.000Z'),
      at('cur-before', '2026-11-29T18:59:59.999Z'),
      at('cur-first', '2026-11-29T19:00:00.000Z'),
      at('cur-last', '2026-11-30T18:59:59.999Z'),
      at('after', '2026-11-30T19:00:00.000Z'),
    ];
    const { current, previous } = splitWeekPosts(posts, window, 'Asia/Karachi');
    expect(ids(current)).toEqual(['cur-first', 'cur-last']);
    expect(ids(previous)).toEqual(['prev-first', 'prev-last']);
  });

  it('cuts at the UTC instants of local midnight (New York, UTC-5)', () => {
    // Week Nov 23-29 against Nov 16-22. Local midnights:
    //   Nov 16 = 11-16T05:00Z, Nov 23 = 11-23T05:00Z, Nov 30 = 11-30T05:00Z.
    const window = {
      from: '2026-11-23',
      to: '2026-11-29',
      previousFrom: '2026-11-16',
      previousTo: '2026-11-22',
    };
    const posts = [
      at('before', '2026-11-16T04:59:59.999Z'),
      at('prev-first', '2026-11-16T05:00:00.000Z'),
      at('prev-last', '2026-11-23T04:59:59.999Z'),
      at('cur-first', '2026-11-23T05:00:00.000Z'),
      at('cur-last', '2026-11-30T04:59:59.999Z'),
      at('after', '2026-11-30T05:00:00.000Z'),
    ];
    const { current, previous } = splitWeekPosts(
      posts,
      window,
      'America/New_York',
    );
    expect(ids(current)).toEqual(['cur-first', 'cur-last']);
    expect(ids(previous)).toEqual(['prev-first', 'prev-last']);
  });

  it.each(['Asia/Karachi', 'America/New_York', 'Pacific/Kiritimati', 'UTC'])(
    'equals the per-post local-date split, every half hour around both midnights (%s)',
    (zone) => {
      const now = new Date('2026-11-29T21:00:00Z');
      const window = weekWindowOf(now, 'monday', zone);
      const HALF_HOUR = 30 * 60 * 1000;
      const start = Date.parse('2026-11-14T00:00:00Z');
      const posts = Array.from({ length: 48 * 18 }, (_, i) =>
        at(String(i), new Date(start + i * HALF_HOUR).toISOString()),
      );
      const { current, previous } = splitWeekPosts(posts, window, zone);
      const byDate = (from: string, to: string) =>
        posts.filter((p) => {
          const d = localDateOf(new Date(p.publishedAt), zone);
          return d >= from && d <= to;
        });
      expect(ids(current)).toEqual(ids(byDate(window.from, window.to)));
      expect(ids(previous)).toEqual(
        ids(byDate(window.previousFrom, window.previousTo)),
      );
      expect(current.length).toBeGreaterThan(0);
      expect(previous.length).toBeGreaterThan(0);
    },
  );
});
