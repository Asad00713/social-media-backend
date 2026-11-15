import type { Measurement } from './classify';
import {
  governingIncident,
  planStatus,
  type ActiveIncident,
  type StoredStatus,
} from './effective-status';

const NOW = new Date('2026-11-15T10:00:00Z');
const EARLIER = new Date('2026-11-15T08:00:00Z');

const summary = {
  publishSample: 0,
  publishFailures: 0,
  publishFailureWorkspaces: 0,
  lagSample: 0,
  medianLagMs: null,
  lagWorkspaces: 0,
  syncSample: 0,
  syncFailures: 0,
  syncFailureWorkspaces: 0,
};

const measured = (
  status: Measurement['status'],
  reason: Measurement['reason'] = status === 'operational'
    ? null
    : 'publish_failures',
): Measurement => ({ status, reason, summary });

const stored = (over: Partial<StoredStatus> = {}): StoredStatus => ({
  platform: 'instagram',
  status: 'operational',
  measuredStatus: 'operational',
  measuredReason: null,
  reason: null,
  incidentId: null,
  signals: {},
  since: EARLIER,
  measuredAt: EARLIER,
  ...over,
});

const incident = (over: Partial<ActiveIncident> = {}): ActiveIncident => ({
  id: 'inc-1',
  platform: 'instagram',
  severity: 'outage',
  title: 'Instagram is down',
  startedAt: EARLIER,
  ...over,
});

function plan(input: {
  stored?: StoredStatus[];
  measured?: Record<string, Measurement>;
  incidents?: ActiveIncident[];
  platforms?: string[];
}) {
  return planStatus({
    platforms: input.platforms ?? ['instagram'],
    stored: new Map((input.stored ?? []).map((s) => [s.platform, s])),
    measured: new Map(Object.entries(input.measured ?? {})),
    incidents: input.incidents ?? [],
    now: NOW,
  });
}

describe('governingIncident', () => {
  it('takes the worst incident naming the platform or every platform', () => {
    const all = incident({ id: 'all', platform: null, severity: 'delayed' });
    const ig = incident({ id: 'ig', severity: 'outage' });
    const fb = incident({ id: 'fb', platform: 'facebook', severity: 'outage' });
    expect(governingIncident('instagram', [all, ig, fb])?.id).toBe('ig');
    expect(governingIncident('threads', [all, ig, fb])?.id).toBe('all');
  });

  it('breaks a severity tie by the most recent start', () => {
    const older = incident({ id: 'older' });
    const newer = incident({ id: 'newer', startedAt: NOW });
    expect(governingIncident('instagram', [older, newer])?.id).toBe('newer');
  });
});

describe('planStatus', () => {
  it('a first operational measurement is not a change', () => {
    const { rows, changes } = plan({
      measured: { instagram: measured('operational') },
    });
    expect(changes).toEqual([]);
    expect(rows[0]).toMatchObject({
      status: 'operational',
      since: NOW,
      changed: false,
    });
  });

  it('records a change only when the shown state moves', () => {
    const same = plan({
      stored: [
        stored({
          status: 'delayed',
          measuredStatus: 'delayed',
          since: EARLIER,
        }),
      ],
      measured: { instagram: measured('delayed') },
    });
    expect(same.changes).toEqual([]);
    expect(same.rows[0].since).toEqual(EARLIER);

    const moved = plan({
      stored: [stored({ status: 'delayed', measuredStatus: 'delayed' })],
      measured: { instagram: measured('outage') },
    });
    expect(moved.changes).toEqual([
      {
        platform: 'instagram',
        from: 'delayed',
        to: 'outage',
        reason: 'publish_failures',
        incidentId: null,
        at: NOW,
      },
    ]);
    expect(moved.rows[0].since).toEqual(NOW);
  });

  it('an active incident overrides the measurement, better or worse', () => {
    const worse = plan({
      measured: { instagram: measured('operational') },
      incidents: [incident({ severity: 'outage' })],
    });
    expect(worse.rows[0]).toMatchObject({
      status: 'outage',
      measuredStatus: 'operational',
      reason: 'incident',
      incidentId: 'inc-1',
    });

    const milder = plan({
      measured: { instagram: measured('outage') },
      incidents: [incident({ severity: 'delayed' })],
    });
    expect(milder.rows[0]).toMatchObject({
      status: 'delayed',
      measuredStatus: 'outage',
    });
  });

  it('falls back to the stored measurement when an incident ends between runs', () => {
    const { rows, changes } = plan({
      stored: [
        stored({
          status: 'outage',
          measuredStatus: 'delayed',
          measuredReason: 'publish_lag',
          reason: 'incident',
          incidentId: 'inc-1',
        }),
      ],
      incidents: [],
    });
    expect(rows[0]).toMatchObject({
      status: 'delayed',
      reason: 'publish_lag',
      incidentId: null,
      measuredAt: EARLIER,
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: 'outage', to: 'delayed' });
  });

  it('a platform-wide incident reaches every platform', () => {
    const { rows } = plan({
      platforms: ['instagram', 'tiktok'],
      incidents: [incident({ platform: null, severity: 'delayed' })],
    });
    expect(rows.map((r) => r.status)).toEqual(['delayed', 'delayed']);
  });
});
