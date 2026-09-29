import { NotFoundException } from '@nestjs/common';
import { HomeService } from './home.service';

/**
 * A db double whose `select()` chains resolve, in call order, to the arrays
 * given — the service issues: channels, daily rows, published posts, workspace.
 */
interface Chain extends PromiseLike<unknown[]> {
  from: () => Chain;
  where: () => Chain;
}

function fakeDb(results: unknown[][]) {
  const calls: string[] = [];
  let i = 0;
  const chain = (): Chain => {
    const c: Chain = {
      from: () => c,
      where: () => c,
      then: (resolve, reject) =>
        Promise.resolve(results[i++] ?? []).then(resolve, reject),
    };
    return c;
  };
  const update = jest.fn(() => ({
    set: () => ({
      where: () => ({
        returning: () => Promise.resolve(results[i++] ?? []),
      }),
    }),
  }));
  return {
    db: { select: () => (calls.push('select'), chain()), update },
    calls,
  };
}

const NOW = new Date('2026-09-30T12:00:00Z'); // Wednesday

describe('HomeService.getSummary', () => {
  it('splits the last 14 days into this week and the week before, per channel', async () => {
    const { db } = fakeDb([
      [{ id: 1 }, { id: 2 }],
      [
        // previous window (Sep 16–22)
        {
          channelId: 1,
          date: '2026-09-20',
          postsPublished: 5,
          totalLikes: 10,
          totalComments: 0,
          totalShares: 0,
          totalImpressions: 1000,
          followersAtEndOfDay: 900,
          followersGained: 10,
        },
        // current window (Sep 23–29)
        {
          channelId: 1,
          date: '2026-09-25',
          postsPublished: 4,
          totalLikes: 20,
          totalComments: 5,
          totalShares: 5,
          totalImpressions: 1500,
          followersAtEndOfDay: 950,
          followersGained: 50,
        },
        {
          channelId: 2,
          date: '2026-09-28',
          postsPublished: 2,
          totalLikes: 0,
          totalComments: 0,
          totalShares: 0,
          totalImpressions: null,
          followersAtEndOfDay: null,
          followersGained: null,
        },
      ],
      [
        { publishedAt: new Date('2026-09-29T08:00:00Z') },
        { publishedAt: new Date('2026-09-22T08:00:00Z') },
      ],
      [{ weeklyPostGoal: 7 }],
    ]);
    const service = new HomeService(db as any);

    const s = await service.getSummary('ws1', NOW);

    expect(s.window).toEqual({
      from: '2026-09-23',
      to: '2026-09-29',
      previousFrom: '2026-09-16',
      previousTo: '2026-09-22',
    });
    expect(s.pulse.postsPublished).toEqual({
      value: 6,
      previous: 5,
      deltaPct: 20,
    });
    expect(s.pulse.impressions).toEqual({
      value: 1500,
      previous: 1000,
      deltaPct: 50,
    });
    expect(s.pulse.engagements).toEqual({
      value: 30,
      previous: 10,
      deltaPct: 200,
      rate: 2,
    });
    expect(s.pulse.followersGained).toEqual({
      value: 50,
      previous: 10,
      deltaPct: 400,
    });
    expect(s.channels).toEqual([
      {
        channelId: 1,
        followers: 950,
        followersGained: 50,
        growthPct: 5.6,
        postsThisWeek: 4,
      },
      {
        channelId: 2,
        followers: null,
        followersGained: null,
        growthPct: null,
        postsThisWeek: 2,
      },
    ]);
    expect(s.streakWeeks).toBe(2);
    expect(s.publishedThisWeek).toBe(1);
    expect(s.weeklyPostGoal).toBe(7);
  });

  it('skips the analytics query for a workspace with no channels', async () => {
    const { db, calls } = fakeDb([[], [], [{ weeklyPostGoal: 5 }]]);
    const s = await new HomeService(db as any).getSummary('ws1', NOW);
    expect(calls).toHaveLength(3);
    expect(s.channels).toEqual([]);
    expect(s.pulse.postsPublished).toEqual({
      value: 0,
      previous: 0,
      deltaPct: null,
    });
    expect(s.pulse.impressions).toEqual({
      value: null,
      previous: null,
      deltaPct: null,
    });
    expect(s.streakWeeks).toBe(0);
  });

  it('throws when the workspace does not exist', async () => {
    const { db } = fakeDb([[], [], []]);
    await expect(
      new HomeService(db as any).getSummary('nope', NOW),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('HomeService.getPulse', () => {
  const daily = (date: string, over: Record<string, number | null> = {}) => ({
    channelId: 1,
    date,
    postsPublished: 0,
    totalLikes: 0,
    totalComments: 0,
    totalShares: 0,
    totalImpressions: null,
    followersAtEndOfDay: null,
    followersGained: null,
    ...over,
  });

  it('compares the chosen number of days with the same span before, with a point per day', async () => {
    const { db } = fakeDb([
      [{ id: 1 }],
      [
        daily('2026-08-15', {
          postsPublished: 4,
          totalLikes: 8,
          totalImpressions: 400,
        }),
        daily('2026-09-10', {
          postsPublished: 6,
          totalLikes: 30,
          totalImpressions: 600,
          followersGained: 12,
        }),
      ],
    ]);

    const p = await new HomeService(db as any).getPulse('ws1', 30, NOW);

    // Whole UTC days ending yesterday, like the summary.
    expect(p.days).toBe(30);
    expect(p.window).toEqual({
      from: '2026-08-31',
      to: '2026-09-29',
      previousFrom: '2026-08-01',
      previousTo: '2026-08-30',
    });
    expect(p.pulse.postsPublished).toEqual({
      value: 6,
      previous: 4,
      deltaPct: 50,
    });
    expect(p.pulse.engagements).toEqual({
      value: 30,
      previous: 8,
      deltaPct: 275,
      rate: 5,
    });
    expect(p.pulse.followersGained).toEqual({
      value: 12,
      previous: null,
      deltaPct: null,
    });
    expect(p.series).toHaveLength(30);
    expect(p.series[0].date).toBe('2026-08-31');
    expect(p.series[29].date).toBe('2026-09-29');
    expect(p.series.find((d) => d.date === '2026-09-10')).toEqual({
      date: '2026-09-10',
      postsPublished: 6,
      impressions: 600,
      engagements: 30,
      followersGained: 12,
    });
  });

  it('uses the same window as the summary for 7 days', async () => {
    const { db } = fakeDb([[{ id: 1 }], []]);
    const p = await new HomeService(db as any).getPulse('ws1', 7, NOW);
    expect(p.window).toEqual({
      from: '2026-09-23',
      to: '2026-09-29',
      previousFrom: '2026-09-16',
      previousTo: '2026-09-22',
    });
    expect(p.series).toHaveLength(7);
  });

  it('skips the analytics query for a workspace with no channels', async () => {
    const { db, calls } = fakeDb([[]]);
    const p = await new HomeService(db as any).getPulse('ws1', 90, NOW);
    expect(calls).toHaveLength(1);
    expect(p.series).toHaveLength(90);
    expect(p.pulse.impressions).toEqual({
      value: null,
      previous: null,
      deltaPct: null,
    });
  });
});

describe('HomeService.setWeeklyPostGoal', () => {
  it('stores the goal and returns it', async () => {
    const { db } = fakeDb([[{ weeklyPostGoal: 9 }]]);
    await expect(
      new HomeService(db as any).setWeeklyPostGoal('ws1', 9),
    ).resolves.toEqual({ weeklyPostGoal: 9 });
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('throws when the workspace does not exist', async () => {
    const { db } = fakeDb([[]]);
    await expect(
      new HomeService(db as any).setWeeklyPostGoal('nope', 9),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
