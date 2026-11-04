import type { FollowerRow } from '../../post-performance/followers';
import { quietFollowers } from './brief-inputs';

const row = (
  date: string,
  gained: number | null,
  followers: number | null = 1000,
  channelId = 3,
): FollowerRow => ({
  channelId,
  date,
  followersAtEndOfDay: followers,
  followersGained: gained,
});

describe('quietFollowers', () => {
  const LAST = '2026-09-30';
  const YESTERDAY = '2026-11-03';
  const growing = [row('2026-09-26', 2), row('2026-09-28', 2)];

  it('reports the count, the gain since and the daily rate before', () => {
    expect(
      quietFollowers(
        [...growing, row('2026-10-10', 0, 1004), row('2026-11-03', 0, 1004)],
        3,
        LAST,
        YESTERDAY,
        YESTERDAY,
      ),
    ).toEqual({ count: 1004, gainedSince: 0, priorPerDay: 2 });
  });

  it('is null when the window ended before yesterday', () => {
    expect(
      quietFollowers(
        [...growing, row('2026-10-10', 0)],
        3,
        LAST,
        YESTERDAY,
        '2026-10-20',
      ),
    ).toBeNull();
  });

  it('is null without a gain reported on both sides of the last post', () => {
    expect(quietFollowers(growing, 3, LAST, YESTERDAY, YESTERDAY)).toBeNull();
    expect(
      quietFollowers([row('2026-10-10', 0)], 3, LAST, YESTERDAY, YESTERDAY),
    ).toBeNull();
  });

  it('is null when no follower count is reported, and ignores other channels', () => {
    expect(
      quietFollowers(
        [...growing, row('2026-10-10', 0)].map((r) => ({
          ...r,
          followersAtEndOfDay: null,
        })),
        3,
        LAST,
        YESTERDAY,
        YESTERDAY,
      ),
    ).toBeNull();
    expect(
      quietFollowers(
        [...growing, row('2026-10-10', 0)],
        4,
        LAST,
        YESTERDAY,
        YESTERDAY,
      ),
    ).toBeNull();
  });
});
