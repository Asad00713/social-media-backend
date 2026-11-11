import type { FollowerRow } from '../../post-performance/followers';
import { audienceGrowth } from './growth';

const WINDOW = { from: '2026-10-01', to: '2026-10-05' };

const row = (
  channelId: number,
  date: string,
  followers: number | null,
): FollowerRow => ({
  channelId,
  date,
  followersAtEndOfDay: followers,
  followersGained: null,
});

const channel = (id: number, accountName = `acct-${id}`) => ({
  id,
  platform: 'instagram' as const,
  accountName,
});

describe('audienceGrowth', () => {
  it('starts from the seed before the window, so day one can already show a change', () => {
    const dto = audienceGrowth(
      [row(1, '2026-09-30', 100), row(1, '2026-10-01', 103)],
      [channel(1)],
      WINDOW,
    );
    const [c] = dto.channels;
    expect(c.series[0]).toEqual({
      date: '2026-10-01',
      followers: 103,
      gained: 3,
    });
    expect(c.change).toBe(3);
    expect(c.current).toBe(103);
    expect(dto.window).toEqual(WINDOW);
  });

  it('uses the latest seed when several rows precede the window', () => {
    const dto = audienceGrowth(
      [
        row(1, '2026-09-20', 90),
        row(1, '2026-09-30', 100),
        row(1, '2026-10-01', 103),
      ],
      [channel(1)],
      WINDOW,
    );
    expect(dto.channels[0].change).toBe(3);
  });

  it('starts from the first in-range reading when there is no seed', () => {
    const dto = audienceGrowth(
      [row(1, '2026-10-03', 50), row(1, '2026-10-05', 55)],
      [channel(1)],
      WINDOW,
    );
    const [c] = dto.channels;
    expect(c.series[0]).toEqual({
      date: '2026-10-01',
      followers: null,
      gained: null,
    });
    expect(c.series[1]).toEqual({
      date: '2026-10-02',
      followers: null,
      gained: null,
    });
    expect(c.series[2]).toEqual({
      date: '2026-10-03',
      followers: 50,
      gained: 0,
    });
    expect(c.change).toBe(5);
  });

  it('carries the last count over a missed day', () => {
    const dto = audienceGrowth(
      [row(1, '2026-10-01', 10), row(1, '2026-10-03', 12)],
      [channel(1)],
      WINDOW,
    );
    const { series } = dto.channels[0];
    expect(series[1]).toEqual({ date: '2026-10-02', followers: 10, gained: 0 });
    expect(series[3]).toEqual({ date: '2026-10-04', followers: 12, gained: 2 });
  });

  it('keeps a drop negative', () => {
    const dto = audienceGrowth(
      [row(1, '2026-09-28', 200), row(1, '2026-10-05', 188)],
      [channel(1)],
      WINDOW,
    );
    const [c] = dto.channels;
    expect(c.change).toBe(-12);
    expect(c.series[4].gained).toBe(-12);
    expect(dto.total.change).toBe(-12);
  });

  it('keeps a channel with no readings, all null, and leaves it out of the total', () => {
    const dto = audienceGrowth(
      [row(1, '2026-10-01', 10)],
      [channel(1), channel(9)],
      WINDOW,
    );
    const empty = dto.channels.find((c) => c.channelId === 9)!;
    expect(empty.current).toBeNull();
    expect(empty.change).toBeNull();
    expect(empty.series).toHaveLength(5);
    for (const p of empty.series) {
      expect(p.followers).toBeNull();
      expect(p.gained).toBeNull();
    }
    expect(dto.total.current).toBe(10);
    expect(dto.total.series.every((p) => p.followers === 10)).toBe(true);
  });

  it('gives a null total when no channel has any reading', () => {
    const dto = audienceGrowth([], [channel(9)], WINDOW);
    expect(dto.total.current).toBeNull();
    expect(dto.total.change).toBeNull();
    expect(
      dto.total.series.every((p) => p.followers === null && p.gained === null),
    ).toBe(true);
  });

  it('sums the total only over channels that have a value that day', () => {
    const dto = audienceGrowth(
      [
        row(1, '2026-09-30', 100),
        row(2, '2026-10-03', 50),
        row(2, '2026-10-05', 60),
      ],
      [channel(1), channel(2)],
      WINDOW,
    );
    const t = dto.total.series;
    expect(t[0]).toEqual({ date: '2026-10-01', followers: 100, gained: 0 });
    expect(t[1]).toEqual({ date: '2026-10-02', followers: 100, gained: 0 });
    expect(t[2]).toEqual({ date: '2026-10-03', followers: 150, gained: 0 });
    expect(t[4]).toEqual({ date: '2026-10-05', followers: 160, gained: 10 });
    expect(dto.total.current).toBe(160);
    expect(dto.total.change).toBe(10);
  });

  it('sorts channels by change, largest first, nulls last, ties by channel id', () => {
    const dto = audienceGrowth(
      [
        row(1, '2026-10-01', 10),
        row(1, '2026-10-05', 12),
        row(2, '2026-10-01', 10),
        row(2, '2026-10-05', 30),
        row(3, '2026-10-01', 10),
        row(3, '2026-10-05', 12),
        row(5, '2026-10-01', 10),
        row(5, '2026-10-05', 5),
      ],
      [channel(9), channel(5), channel(3), channel(2), channel(1)],
      WINDOW,
    );
    expect(dto.channels.map((c) => c.channelId)).toEqual([2, 1, 3, 5, 9]);
  });

  it('maps the account name and platform onto each channel', () => {
    const dto = audienceGrowth([], [channel(4, 'Acme')], WINDOW);
    expect(dto.channels[0]).toMatchObject({
      channelId: 4,
      platform: 'instagram',
      name: 'Acme',
    });
  });
});
