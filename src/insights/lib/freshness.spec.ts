import {
  freshnessOf,
  type FreshnessChannel,
  type SyncStateRow,
} from './freshness';

const NOW = new Date('2026-09-30T12:00:00Z');

const channel = (
  id: number,
  over: Partial<FreshnessChannel> = {},
): FreshnessChannel => ({
  id,
  platform: 'instagram',
  isActive: true,
  connectionStatus: 'connected',
  ...over,
});
const sync = (channelId: number, over: Partial<SyncStateRow> = {}) => ({
  channelId,
  lastProfileSyncAt: null,
  lastPostsSyncAt: null,
  consecutiveFailures: 0,
  pausedUntil: null,
  initialBackfillStatus: 'completed' as const,
  ...over,
});

describe('freshnessOf', () => {
  it('takes the later sync and flags a channel that keeps failing or is paused', () => {
    expect(
      freshnessOf(
        [channel(1), channel(2), channel(3), channel(4)],
        [
          sync(1, {
            lastProfileSyncAt: new Date('2026-09-30T10:00:00Z'),
            lastPostsSyncAt: new Date('2026-09-30T11:00:00Z'),
          }),
          sync(2, {
            lastProfileSyncAt: new Date('2026-09-20T10:00:00Z'),
            consecutiveFailures: 3,
          }),
          sync(3, { pausedUntil: new Date('2026-10-01T00:00:00Z') }),
        ],
        NOW,
      ).map(({ channelId, lastSyncedAt, failing }) => ({
        channelId,
        lastSyncedAt,
        failing,
      })),
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
      [channel(1)],
      [sync(1, { pausedUntil: new Date('2026-09-29T00:00:00Z') })],
      NOW,
    );
    expect(f.failing).toBe(false);
  });

  it('carries the pause, the connection and the backfill, pending without a row', () => {
    expect(
      freshnessOf(
        [
          channel(1, { isActive: false }),
          channel(2, { connectionStatus: 'expired' }),
          channel(3),
        ],
        [
          sync(1, { initialBackfillStatus: 'running' }),
          sync(2, { initialBackfillStatus: 'failed' }),
        ],
        NOW,
      ).map(({ channelId, isActive, connectionStatus, backfill }) => ({
        channelId,
        isActive,
        connectionStatus,
        backfill,
      })),
    ).toEqual([
      {
        channelId: 1,
        isActive: false,
        connectionStatus: 'connected',
        backfill: 'running',
      },
      {
        channelId: 2,
        isActive: true,
        connectionStatus: 'expired',
        backfill: 'failed',
      },
      {
        channelId: 3,
        isActive: true,
        connectionStatus: 'connected',
        backfill: 'pending',
      },
    ]);
  });

  it('says what each platform reports, from its capabilities', () => {
    const reports = freshnessOf(
      [
        channel(1, { platform: 'instagram' }),
        channel(2, { platform: 'tiktok' }),
        channel(3, { platform: 'linkedin' }),
        channel(4, { platform: 'bluesky' }),
      ],
      [],
      NOW,
    ).map(({ reportsViews, reportsReach, reportsFollowers }) => [
      reportsViews,
      reportsReach,
      reportsFollowers,
    ]);
    expect(reports).toEqual([
      [true, true, true],
      [true, false, true],
      [false, false, false],
      [false, false, true],
    ]);
  });

  it('a google_business channel does not throw and reports nothing', () => {
    expect(
      freshnessOf([channel(5, { platform: 'google_business' })], [], NOW),
    ).toEqual([
      {
        channelId: 5,
        lastSyncedAt: null,
        failing: false,
        isActive: true,
        connectionStatus: 'connected',
        backfill: 'pending',
        reportsViews: false,
        reportsReach: false,
        reportsFollowers: false,
      },
    ]);
  });
});
