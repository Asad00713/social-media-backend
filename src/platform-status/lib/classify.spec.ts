import {
  DELAYED_LAG_MS,
  MIN_PUBLISH_SAMPLE,
  failureSide,
  measurePlatform,
  type LagSample,
  type PlatformSignals,
  type PublishOutcome,
  type SyncSample,
} from './classify';

const ok = (ws: string): PublishOutcome => ({
  workspaceId: ws,
  result: 'published',
});
const fail = (
  ws: string,
  errorMessage = 'Request failed with status code 503',
  errorCode?: string,
): PublishOutcome => ({
  workspaceId: ws,
  result: 'failed',
  errorMessage,
  errorCode,
});

/** `n` outcomes spread round-robin over `workspaces` workspaces. */
function spread(
  n: number,
  workspaces: number,
  make: (ws: string) => PublishOutcome,
): PublishOutcome[] {
  return Array.from({ length: n }, (_, i) => make(`ws-${i % workspaces}`));
}

function signals(over: Partial<PlatformSignals> = {}): PlatformSignals {
  return { publishes: [], lags: [], syncs: [], ...over };
}

describe('failureSide', () => {
  it.each([
    ['a 503', 'Request failed with status code 503', 'platform'],
    ['a gateway timeout', 'Gateway Timeout', 'platform'],
    ['a socket reset', 'read ECONNRESET', 'platform'],
    ['the platform rate limit', 'Too many requests', 'platform'],
    [
      'our global limiter',
      'Rate limit exceeded. Retry after 3 minutes',
      'platform',
    ],
    [
      'our per-channel limiter',
      'Channel rate limit exceeded. Retry after 2 minutes',
      'customer',
    ],
    [
      'the per-channel history row',
      'Per-channel rate limit exceeded',
      'customer',
    ],
    [
      'an expired token',
      'Error validating access token: token expired',
      'customer',
    ],
    ['a 401', 'Request failed with status code 401', 'customer'],
    ['bad media', 'Media upload invalid: file too large', 'customer'],
    ['a duplicate', 'Status is a duplicate.', 'customer'],
    ['an unknown error', 'Something odd happened', 'customer'],
  ])('reads %s as %s', (_label, message, side) => {
    expect(failureSide({ result: 'failed', errorMessage: message })).toBe(side);
  });

  it('trusts the composer code over the message', () => {
    expect(
      failureSide({
        result: 'failed',
        errorCode: 'media_invalid',
        errorMessage: '503',
      }),
    ).toBe('customer');
    expect(
      failureSide({
        result: 'failed',
        errorCode: 'transient',
        errorMessage: 'x',
      }),
    ).toBe('platform');
  });

  it('a published outcome is ok', () => {
    expect(failureSide({ result: 'published' })).toBe('ok');
  });
});

describe('measurePlatform: publish failures', () => {
  it('is operational with no signals', () => {
    expect(measurePlatform(signals())).toMatchObject({
      status: 'operational',
      reason: null,
    });
  });

  it('calls an outage at 60% platform-side failures across 3+ workspaces', () => {
    const publishes = [...spread(6, 3, (ws) => fail(ws)), ...spread(4, 3, ok)];
    expect(measurePlatform(signals({ publishes }))).toMatchObject({
      status: 'outage',
      reason: 'publish_failures',
    });
  });

  it('calls delayed at 20% and stays operational just below', () => {
    const at20 = [...spread(3, 3, (ws) => fail(ws)), ...spread(12, 3, ok)];
    expect(measurePlatform(signals({ publishes: at20 })).status).toBe(
      'delayed',
    );
    const below = [...spread(3, 3, (ws) => fail(ws)), ...spread(13, 3, ok)];
    expect(measurePlatform(signals({ publishes: below })).status).toBe(
      'operational',
    );
  });

  it('never flags a platform on fewer outcomes than the minimum sample', () => {
    const publishes = spread(MIN_PUBLISH_SAMPLE - 1, 5, (ws) => fail(ws));
    expect(measurePlatform(signals({ publishes })).status).toBe('operational');
  });

  it('never flags a platform when the failures come from fewer than 3 workspaces', () => {
    // 100% failure, big sample, but one account (two workspaces) only.
    const publishes = [
      ...spread(20, 2, (ws) => fail(ws)),
      ...spread(5, 5, ok).map((o) => ({
        ...o,
        workspaceId: `ok-${o.workspaceId}`,
      })),
    ];
    expect(measurePlatform(signals({ publishes })).status).toBe('operational');
  });

  it('ignores customer-side failures in the rate', () => {
    // 10 expired tokens + 10 successes: the platform is fine.
    const publishes = [
      ...spread(10, 5, (ws) => fail(ws, 'token expired', 'auth_failed')),
      ...spread(10, 5, ok),
    ];
    expect(measurePlatform(signals({ publishes })).status).toBe('operational');
  });

  it('keeps a state until the rate falls below half its bar (hysteresis)', () => {
    // 40%: under the 60% outage bar, over half of it.
    const at40 = [...spread(4, 4, (ws) => fail(ws)), ...spread(6, 3, ok)];
    expect(
      measurePlatform(signals({ publishes: at40 }), 'operational').status,
    ).toBe('delayed');
    expect(measurePlatform(signals({ publishes: at40 }), 'outage').status).toBe(
      'outage',
    );
    // 25%: below half the outage bar, so an outage steps down to delayed.
    const at25 = [...spread(3, 3, (ws) => fail(ws)), ...spread(9, 3, ok)];
    expect(measurePlatform(signals({ publishes: at25 }), 'outage').status).toBe(
      'delayed',
    );
    // 12%: below the 20% delayed bar, above half of it.
    const at12 = [...spread(3, 3, (ws) => fail(ws)), ...spread(22, 3, ok)];
    expect(
      measurePlatform(signals({ publishes: at12 }), 'operational').status,
    ).toBe('operational');
    expect(
      measurePlatform(signals({ publishes: at12 }), 'delayed').status,
    ).toBe('delayed');
  });
});

describe('measurePlatform: lag', () => {
  const late = (ws: string, minutes: number): LagSample => ({
    workspaceId: ws,
    lagMs: minutes * 60_000,
  });

  it('calls delayed when the median scheduled post is 10+ minutes late', () => {
    const lags = [
      late('a', 12),
      late('b', 15),
      late('c', 11),
      late('d', 1),
      late('e', 20),
    ];
    expect(measurePlatform(signals({ lags }))).toMatchObject({
      status: 'delayed',
      reason: 'publish_lag',
    });
  });

  it('never calls an outage on lag alone', () => {
    const lags = ['a', 'b', 'c', 'd', 'e'].map((ws) => late(ws, 300));
    expect(measurePlatform(signals({ lags })).status).toBe('delayed');
  });

  it('needs late posts in 3 workspaces', () => {
    const lags = [
      late('a', 30),
      late('a', 30),
      late('b', 30),
      late('b', 30),
      late('b', 30),
    ];
    expect(measurePlatform(signals({ lags })).status).toBe('operational');
  });

  it('needs the minimum lag sample', () => {
    const lags = [late('a', 30), late('b', 30), late('c', 30), late('d', 30)];
    expect(measurePlatform(signals({ lags })).status).toBe('operational');
  });

  it('drops samples beyond six hours (a person publishing later)', () => {
    const lags = ['a', 'b', 'c', 'd', 'e'].map((ws) => late(ws, 7 * 60));
    expect(measurePlatform(signals({ lags })).summary.lagSample).toBe(0);
  });

  it('keeps delayed down to half the lag bar', () => {
    const lags = ['a', 'b', 'c', 'd', 'e'].map((ws) => ({
      workspaceId: ws,
      lagMs: DELAYED_LAG_MS * 0.6,
    }));
    expect(measurePlatform(signals({ lags }), 'operational').status).toBe(
      'operational',
    );
    expect(measurePlatform(signals({ lags }), 'delayed').status).toBe(
      'delayed',
    );
  });
});

describe('measurePlatform: sync', () => {
  const sync = (
    ws: string,
    result: SyncSample['result'],
    errorMessage?: string,
  ): SyncSample => ({ workspaceId: ws, result, errorMessage });

  it('calls delayed when half the synced channels hit platform errors', () => {
    const syncs = [
      ...['a', 'b', 'c', 'd', 'e'].map((ws) => sync(ws, 'rate_limited')),
      ...['f', 'g', 'h', 'i', 'j'].map((ws) => sync(ws, 'success')),
    ];
    expect(measurePlatform(signals({ syncs }))).toMatchObject({
      status: 'delayed',
      reason: 'sync_failures',
    });
  });

  it('ignores auth failures', () => {
    const syncs = [
      ...['a', 'b', 'c', 'd', 'e', 'f'].map((ws) =>
        sync(ws, 'failed', 'token expired'),
      ),
      ...['g', 'h', 'i', 'j'].map((ws) => sync(ws, 'success')),
    ];
    expect(measurePlatform(signals({ syncs })).status).toBe('operational');
  });

  it('a publish outage wins over a sync delay', () => {
    const publishes = spread(10, 5, (ws) => fail(ws));
    const syncs = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((ws) =>
      sync(ws, 'rate_limited'),
    );
    expect(measurePlatform(signals({ publishes, syncs })).status).toBe(
      'outage',
    );
  });
});
