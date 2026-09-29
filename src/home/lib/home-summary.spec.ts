import {
  computeStreakWeeks,
  dailySeries,
  deltaPct,
  isPulseRange,
  summarizeChannel,
  summarizeWindow,
  weekStart,
  type DailyRow,
} from './home-summary';

const row = (over: Partial<DailyRow>): DailyRow => ({
  channelId: 1,
  date: '2026-09-20',
  postsPublished: 0,
  totalLikes: 0,
  totalComments: 0,
  totalShares: 0,
  totalImpressions: null,
  followersAtEndOfDay: null,
  followersGained: null,
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

describe('summarizeWindow', () => {
  it('sums posts, impressions, engagements and follower gains across channels', () => {
    const s = summarizeWindow([
      row({
        channelId: 1,
        postsPublished: 2,
        totalLikes: 10,
        totalComments: 3,
        totalShares: 1,
        totalImpressions: 400,
        followersGained: 5,
      }),
      row({
        channelId: 2,
        postsPublished: 1,
        totalLikes: 6,
        totalImpressions: 100,
        followersGained: -2,
      }),
    ]);
    expect(s).toEqual({
      postsPublished: 3,
      impressions: 500,
      engagements: 20,
      engagementRate: 4,
      followersGained: 3,
    });
  });

  it('reports unknown impressions and follower gains as null, not zero', () => {
    const s = summarizeWindow([row({ postsPublished: 1, totalLikes: 4 })]);
    expect(s.impressions).toBeNull();
    expect(s.engagementRate).toBeNull();
    expect(s.followersGained).toBeNull();
    expect(s.engagements).toBe(4);
  });
});

describe('summarizeChannel', () => {
  it('takes the latest follower count and computes growth over the window', () => {
    const c = summarizeChannel(7, [
      row({
        channelId: 7,
        date: '2026-09-21',
        followersAtEndOfDay: 1000,
        followersGained: 10,
        postsPublished: 1,
      }),
      row({
        channelId: 7,
        date: '2026-09-23',
        followersAtEndOfDay: 1030,
        followersGained: 20,
        postsPublished: 2,
      }),
    ]);
    expect(c).toEqual({
      channelId: 7,
      followers: 1030,
      followersGained: 30,
      growthPct: 3,
      postsThisWeek: 3,
    });
  });

  it('has no growth when the starting count is unknown or zero', () => {
    expect(summarizeChannel(7, []).growthPct).toBeNull();
    expect(
      summarizeChannel(7, [
        row({ channelId: 7, followersAtEndOfDay: 5, followersGained: 5 }),
      ]).growthPct,
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
  it('has one point per day in the window, summed across channels', () => {
    const series = dailySeries(
      [
        row({
          channelId: 1,
          date: '2026-09-21',
          postsPublished: 2,
          totalLikes: 5,
          totalComments: 1,
          totalImpressions: 100,
          followersGained: 3,
        }),
        row({
          channelId: 2,
          date: '2026-09-21',
          postsPublished: 1,
          totalShares: 4,
          totalImpressions: 50,
        }),
        row({ channelId: 1, date: '2026-09-23', totalLikes: 2 }),
      ],
      '2026-09-21',
      '2026-09-23',
    );
    expect(series).toEqual([
      {
        date: '2026-09-21',
        postsPublished: 3,
        impressions: 150,
        engagements: 10,
        followersGained: 3,
      },
      // A day with no rows at all is still on the line, at zero.
      {
        date: '2026-09-22',
        postsPublished: 0,
        impressions: null,
        engagements: 0,
        followersGained: null,
      },
      {
        date: '2026-09-23',
        postsPublished: 0,
        impressions: null,
        engagements: 2,
        followersGained: null,
      },
    ]);
  });

  it('leaves out rows outside the window', () => {
    const series = dailySeries(
      [row({ date: '2026-09-20', postsPublished: 9 })],
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
      dailySeries([], '2026-09-29', '2026-10-02').map((d) => d.date),
    ).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  });
});

describe('isPulseRange', () => {
  it('accepts 7, 30 and 90 days only', () => {
    expect([7, 30, 90].every(isPulseRange)).toBe(true);
    expect([0, 1, 14, 31, 365, NaN].some(isPulseRange)).toBe(false);
  });
});
