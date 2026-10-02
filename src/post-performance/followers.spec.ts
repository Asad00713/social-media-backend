import {
  followersByDay,
  followersGainedOf,
  type FollowerRow,
} from './followers';

const row = (over: Partial<FollowerRow>): FollowerRow => ({
  channelId: 1,
  date: '2026-09-20',
  followersAtEndOfDay: null,
  followersGained: null,
  ...over,
});

describe('followersGainedOf', () => {
  it('adds the daily gains across channels, losses included', () => {
    expect(
      followersGainedOf([
        row({ channelId: 1, followersGained: 5 }),
        row({ channelId: 2, followersGained: -2 }),
      ]),
    ).toBe(3);
  });
  it('is null, not zero, when no channel reported a change', () => {
    expect(followersGainedOf([row({})])).toBeNull();
  });
});

describe('followersByDay', () => {
  it("carries each channel's last count over days the rollup missed", () => {
    const totals = followersByDay(
      [
        // Seeds the carry: before the range.
        row({ channelId: 1, date: '2026-09-18', followersAtEndOfDay: 100 }),
        row({ channelId: 2, date: '2026-09-20', followersAtEndOfDay: 50 }),
        row({ channelId: 1, date: '2026-09-21', followersAtEndOfDay: 110 }),
      ],
      '2026-09-19',
      '2026-09-22',
    );
    expect([...totals.entries()]).toEqual([
      ['2026-09-19', 100],
      ['2026-09-20', 150],
      ['2026-09-21', 160],
      ['2026-09-22', 160],
    ]);
  });

  it('is null on days before any channel reported', () => {
    const totals = followersByDay(
      [row({ date: '2026-09-21', followersAtEndOfDay: 7 })],
      '2026-09-20',
      '2026-09-21',
    );
    expect(totals.get('2026-09-20')).toBeNull();
    expect(totals.get('2026-09-21')).toBe(7);
  });

  it('ignores a null count instead of wiping the carry', () => {
    const totals = followersByDay(
      [
        row({ date: '2026-09-20', followersAtEndOfDay: 40 }),
        row({ date: '2026-09-21', followersAtEndOfDay: null }),
      ],
      '2026-09-21',
      '2026-09-21',
    );
    expect(totals.get('2026-09-21')).toBe(40);
  });
});
