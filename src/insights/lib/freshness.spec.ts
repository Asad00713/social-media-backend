import { freshnessOf } from './freshness';

const NOW = new Date('2026-09-30T12:00:00Z');

describe('freshnessOf', () => {
  it('takes the later sync and flags a channel that keeps failing or is paused', () => {
    expect(
      freshnessOf(
        [1, 2, 3, 4],
        [
          {
            channelId: 1,
            lastProfileSyncAt: new Date('2026-09-30T10:00:00Z'),
            lastPostsSyncAt: new Date('2026-09-30T11:00:00Z'),
            consecutiveFailures: 0,
            pausedUntil: null,
          },
          {
            channelId: 2,
            lastProfileSyncAt: new Date('2026-09-20T10:00:00Z'),
            lastPostsSyncAt: null,
            consecutiveFailures: 3,
            pausedUntil: null,
          },
          {
            channelId: 3,
            lastProfileSyncAt: null,
            lastPostsSyncAt: null,
            consecutiveFailures: 0,
            pausedUntil: new Date('2026-10-01T00:00:00Z'),
          },
        ],
        NOW,
      ),
    ).toEqual([
      {
        channelId: 1,
        lastSyncedAt: '2026-09-30T11:00:00.000Z',
        failing: false,
      },
      { channelId: 2, lastSyncedAt: '2026-09-20T10:00:00.000Z', failing: true },
      { channelId: 3, lastSyncedAt: null, failing: true },
      // No sync row yet: never synced, not failing.
      { channelId: 4, lastSyncedAt: null, failing: false },
    ]);
  });

  it('does not flag a pause that already ended', () => {
    const [f] = freshnessOf(
      [1],
      [
        {
          channelId: 1,
          lastProfileSyncAt: null,
          lastPostsSyncAt: null,
          consecutiveFailures: 0,
          pausedUntil: new Date('2026-09-29T00:00:00Z'),
        },
      ],
      NOW,
    );
    expect(f.failing).toBe(false);
  });
});
