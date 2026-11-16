import type { PlatformSignals } from './lib/classify';
import type { ActiveIncident, StoredStatus } from './lib/effective-status';
import { STATUS_PLATFORMS } from './lib/status-platforms';
import { PlatformStatusService } from './platform-status.service';
import type { PlatformStatusRepository } from './platform-status.repository';

const NOW = new Date('2026-11-15T10:00:00Z');

/** 10 platform-side failures from 5 workspaces: an outage. */
function failing(): PlatformSignals {
  return {
    publishes: Array.from({ length: 10 }, (_, i) => ({
      workspaceId: `ws-${i % 5}`,
      result: 'failed' as const,
      errorMessage: 'Request failed with status code 503',
    })),
    lags: [],
    syncs: [],
  };
}

function build(state: {
  signals?: Map<string, PlatformSignals>;
  stored?: StoredStatus[];
  incidents?: ActiveIncident[];
}) {
  const saved: { rows: unknown[]; changes: unknown[] }[] = [];
  const repo = {
    loadSignals: jest.fn().mockResolvedValue(state.signals ?? new Map()),
    withStatusLock: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn({})),
    loadStored: jest
      .fn()
      .mockResolvedValue(
        new Map((state.stored ?? []).map((s) => [s.platform, s])),
      ),
    activeIncidents: jest.fn().mockResolvedValue(state.incidents ?? []),
    save: jest.fn((_tx: unknown, rows: unknown[], changes: unknown[]) => {
      saved.push({ rows, changes });
      return Promise.resolve();
    }),
  };
  const emitter = { broadcast: jest.fn() };
  const service = new PlatformStatusService(
    repo as unknown as PlatformStatusRepository,
    emitter as never,
  );
  return { service, repo, emitter, saved };
}

function storedAs(
  platform: string,
  over: Partial<StoredStatus> = {},
): StoredStatus {
  return {
    platform,
    status: 'operational',
    measuredStatus: 'operational',
    measuredReason: null,
    reason: null,
    incidentId: null,
    signals: {},
    since: new Date('2026-11-14T00:00:00Z'),
    measuredAt: new Date('2026-11-15T09:58:00Z'),
    ...over,
  };
}

describe('PlatformStatusService.recompute', () => {
  it('writes a row for every platform and announces nothing when nothing changed', async () => {
    const { service, emitter, saved } = build({});
    const changes = await service.recompute(NOW);
    expect(changes).toEqual([]);
    expect(saved[0].rows).toHaveLength(STATUS_PLATFORMS.length);
    expect(emitter.broadcast).not.toHaveBeenCalled();
  });

  it('broadcasts one platform.status.changed per platform that changed', async () => {
    const { service, emitter } = build({
      signals: new Map([['instagram', failing()]]),
    });
    await service.recompute(NOW);
    expect(emitter.broadcast).toHaveBeenCalledTimes(1);
    expect(emitter.broadcast).toHaveBeenCalledWith('platform.status.changed', {
      platform: 'instagram',
      status: 'outage',
      previousStatus: 'operational',
      since: NOW.toISOString(),
      reason: 'publish_failures',
      message: 'Posts may fail until it’s back. You can retry them then.',
      incident: null,
    });
  });

  it('does not announce again while the state holds', async () => {
    const { service, emitter } = build({
      signals: new Map([['instagram', failing()]]),
      stored: [
        storedAs('instagram', {
          status: 'outage',
          measuredStatus: 'outage',
          measuredReason: 'publish_failures',
          reason: 'publish_failures',
        }),
      ],
    });
    await service.recompute(NOW);
    expect(emitter.broadcast).not.toHaveBeenCalled();
  });

  it('measures from the stored MEASURED state, not the incident-shown one', async () => {
    const { service, repo } = build({
      stored: [storedAs('instagram', { status: 'outage', reason: 'incident' })],
      incidents: [
        {
          id: 'inc-1',
          platform: 'instagram',
          severity: 'outage',
          title: 'Instagram is down',
          startedAt: NOW,
        },
      ],
    });
    const changes = await service.recompute(NOW);
    expect(changes).toEqual([]);
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it('announces after the lock is released, with the incident title', async () => {
    const order: string[] = [];
    const { service, repo, emitter } = build({
      incidents: [
        {
          id: 'inc-1',
          platform: null,
          severity: 'delayed',
          title: 'Meta is slow',
          startedAt: NOW,
        },
      ],
    });
    repo.withStatusLock.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const out = await fn({});
        order.push('commit');
        return out;
      },
    );
    emitter.broadcast.mockImplementation(() => order.push('emit'));
    await service.applyIncidents(NOW);
    expect(repo.loadSignals).not.toHaveBeenCalled();
    expect(order[0]).toBe('commit');
    expect(emitter.broadcast).toHaveBeenCalledTimes(STATUS_PLATFORMS.length);
    expect(emitter.broadcast).toHaveBeenCalledWith(
      'platform.status.changed',
      expect.objectContaining({
        status: 'delayed',
        reason: 'incident',
        incident: { id: 'inc-1', title: 'Meta is slow' },
      }),
    );
  });
});

describe('PlatformStatusService.getStatusPage', () => {
  it('lists every platform, operational with no row, and drops unknown platforms from history', async () => {
    const repo = {
      statusRows: jest.fn().mockResolvedValue([
        storedAs('tiktok', {
          status: 'outage',
          reason: 'incident',
          incidentId: 'inc-1',
          since: NOW,
        }),
      ]),
      openIncidents: jest.fn().mockResolvedValue([
        {
          id: 'inc-1',
          platform: 'tiktok',
          severity: 'outage',
          title: 'TikTok is down',
          body: null,
          startedAt: NOW,
          resolvedAt: null,
          updatedAt: NOW,
        },
      ]),
      resolvedSince: jest.fn().mockResolvedValue([]),
      changesSince: jest.fn().mockResolvedValue([
        {
          id: 'c1',
          platform: 'tiktok',
          fromStatus: 'operational',
          toStatus: 'outage',
          reason: 'incident',
          incidentId: 'inc-1',
          createdAt: NOW,
        },
        {
          id: 'c2',
          platform: 'reddit',
          fromStatus: 'operational',
          toStatus: 'delayed',
          reason: null,
          incidentId: null,
          createdAt: NOW,
        },
      ]),
    };
    const service = new PlatformStatusService(repo as never, {} as never);
    const page = await service.getStatusPage(NOW);
    expect(page.platforms.map((p) => p.platform)).toEqual([
      ...STATUS_PLATFORMS,
    ]);
    expect(page.platforms.find((p) => p.platform === 'tiktok')).toEqual({
      platform: 'tiktok',
      status: 'outage',
      since: NOW.toISOString(),
      reason: 'incident',
      message: 'Posts may fail until it’s back. You can retry them then.',
      incident: { id: 'inc-1', title: 'TikTok is down' },
    });
    expect(
      page.platforms.find((p) => p.platform === 'instagram'),
    ).toMatchObject({
      status: 'operational',
      since: null,
    });
    expect(page.changes.map((c) => c.id)).toEqual(['c1']);
    expect(page.checkedAt).toBe('2026-11-15T09:58:00.000Z');
  });
});
