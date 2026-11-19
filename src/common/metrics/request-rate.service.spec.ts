import {
  percentile,
  RATE_WINDOW_TTL_SECONDS,
  RequestRateService,
  type RequestRateRedis,
} from './request-rate.service';
import { workspaceIdOf } from './request-rate.interceptor';

/**
 * Measurement before enforcement.
 *
 * The global throttler guard is off because the platform "has not been
 * measured for it" (`app.module.ts`). This counts; it must never refuse, never
 * slow a request, and never grow the key space without bound — the last one
 * because a row-per-request design is exactly how `error_logs` reached 738MB
 * and 2.17M rows in 17 days (BE #128).
 */

interface FakeRedis extends RequestRateRedis {
  store: Map<string, number>;
  ttls: Map<string, number>;
  calls: string[];
  failWith?: Error;
}

function fakeRedis(): FakeRedis {
  const store = new Map<string, number>();
  const ttls = new Map<string, number>();
  const calls: string[] = [];
  const self: FakeRedis = {
    store,
    ttls,
    calls,
    incr(key) {
      calls.push(`incr ${key}`);
      if (self.failWith) return Promise.reject(self.failWith);
      const next = (store.get(key) ?? 0) + 1;
      store.set(key, next);
      return Promise.resolve(next);
    },
    expire(key, seconds) {
      calls.push(`expire ${key} ${seconds}`);
      ttls.set(key, seconds);
      return Promise.resolve(1);
    },
    zadd(key, score, member) {
      calls.push(`zadd ${key} ${member}`);
      void score;
      return Promise.resolve(1);
    },
    zrange() {
      return Promise.resolve([]);
    },
    keys(pattern) {
      const re = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
      return Promise.resolve([...store.keys()].filter((k) => re.test(k)));
    },
    mget(...keys) {
      return Promise.resolve(
        keys.map((k) => {
          const v = store.get(k);
          return v === undefined ? null : String(v);
        }),
      );
    },
    del(...keys) {
      keys.forEach((k) => store.delete(k));
      return Promise.resolve(keys.length);
    },
  };
  return self;
}

/** Lets the un-awaited `record()` writes settle. */
const settle = () => new Promise((r) => setImmediate(r));

const AT = new Date('2026-11-19T13:07:42.000Z');

describe('counting a request', () => {
  it('counts the route and the workspace separately', async () => {
    const redis = fakeRedis();
    const svc = new RequestRateService(redis);

    svc.record({ workspaceId: 'ws-1', route: '/posts/:id' }, AT);
    await settle();

    expect(redis.store.get('rate:route:/posts/:id:2026-11-19T1307')).toBe(1);
    expect(redis.store.get('rate:ws:ws-1:2026-11-19T1307')).toBe(1);
  });

  it('counts an unauthenticated request by route alone', async () => {
    const redis = fakeRedis();
    const svc = new RequestRateService(redis);

    svc.record({ route: '/auth/login' }, AT);
    await settle();

    expect([...redis.store.keys()]).toEqual([
      'rate:route:/auth/login:2026-11-19T1307',
    ]);
  });

  it('buckets by the minute, not the second', async () => {
    const redis = fakeRedis();
    const svc = new RequestRateService(redis);

    svc.record({ route: '/r' }, new Date('2026-11-19T13:07:01.000Z'));
    svc.record({ route: '/r' }, new Date('2026-11-19T13:07:59.000Z'));
    await settle();

    expect(redis.store.get('rate:route:/r:2026-11-19T1307')).toBe(2);
  });

  it('starts a new counter in the next minute', async () => {
    const redis = fakeRedis();
    const svc = new RequestRateService(redis);

    svc.record({ route: '/r' }, new Date('2026-11-19T13:07:59.000Z'));
    svc.record({ route: '/r' }, new Date('2026-11-19T13:08:00.000Z'));
    await settle();

    expect(redis.store.get('rate:route:/r:2026-11-19T1307')).toBe(1);
    expect(redis.store.get('rate:route:/r:2026-11-19T1308')).toBe(1);
  });
});

describe('every key expires itself', () => {
  it('sets a TTL on a key the first time it is written', async () => {
    const redis = fakeRedis();
    const svc = new RequestRateService(redis);

    svc.record({ workspaceId: 'ws-1', route: '/r' }, AT);
    await settle();

    // Both keys, not just one: a workspace key without a TTL is an unbounded
    // key space with one customer's id in it.
    expect(redis.ttls.get('rate:route:/r:2026-11-19T1307')).toBe(
      RATE_WINDOW_TTL_SECONDS,
    );
    expect(redis.ttls.get('rate:ws:ws-1:2026-11-19T1307')).toBe(
      RATE_WINDOW_TTL_SECONDS,
    );
  });

  it('does not re-set the TTL on every request', async () => {
    const redis = fakeRedis();
    const svc = new RequestRateService(redis);

    for (let i = 0; i < 5; i += 1) {
      svc.record({ route: '/r' }, AT);
      await settle();
    }

    // One EXPIRE for five requests: re-setting it each time would be an extra
    // round trip per request on every route in the app, for no change.
    expect(redis.calls.filter((c) => c.startsWith('expire'))).toHaveLength(1);
  });

  it('keeps the window short enough to be self-limiting', () => {
    // 36h: long enough to read a full day's distribution, short enough that
    // the key space cannot accumulate. There is no sweeper to forget to run.
    expect(RATE_WINDOW_TTL_SECONDS).toBeLessThanOrEqual(48 * 60 * 60);
    expect(RATE_WINDOW_TTL_SECONDS).toBeGreaterThanOrEqual(24 * 60 * 60);
  });
});

describe('it cannot break a request', () => {
  it('does not throw when Redis is down', async () => {
    const redis = fakeRedis();
    redis.failWith = new Error('ECONNREFUSED');
    const svc = new RequestRateService(redis);

    expect(() => svc.record({ route: '/r' }, AT)).not.toThrow();
    await settle();
  });

  it('returns synchronously — the caller never awaits a Redis round trip', () => {
    const redis = fakeRedis();
    const svc = new RequestRateService(redis);

    // `record` returning void is the contract: an awaited metrics write would
    // put Redis latency in front of every customer response.
    expect(svc.record({ route: '/r' }, AT)).toBeUndefined();
  });

  it('warns once per process, not once per failed request', async () => {
    const redis = fakeRedis();
    redis.failWith = new Error('ECONNREFUSED');
    const svc = new RequestRateService(redis);
    const warn = jest
      .spyOn(
        (svc as unknown as { logger: { warn: (m: string) => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    for (let i = 0; i < 50; i += 1) {
      svc.record({ route: '/r' }, AT);
      await settle();
    }

    // A Redis outage must not itself become log spam. `AppLoggerService.warn`
    // persists a row, so 50 warns is 50 rows — the BE #128 failure in
    // miniature.
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('says plainly that no request was affected', async () => {
    const redis = fakeRedis();
    redis.failWith = new Error('ECONNREFUSED');
    const svc = new RequestRateService(redis);
    const warn = jest
      .spyOn(
        (svc as unknown as { logger: { warn: (m: string) => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    svc.record({ route: '/r' }, AT);
    await settle();

    expect(warn.mock.calls[0]?.[0]).toMatch(/no requests affected/i);
    warn.mockRestore();
  });
});

describe('the distribution a limit gets chosen from', () => {
  async function withCounts(
    counts: Record<string, number>,
  ): Promise<RequestRateService> {
    const redis = fakeRedis();
    const svc = new RequestRateService(redis);
    for (const [ws, n] of Object.entries(counts)) {
      for (let i = 0; i < n; i += 1) {
        svc.record({ workspaceId: ws, route: '/r' }, AT);
        await settle();
      }
    }
    return svc;
  }

  it('reports nothing rather than zeroes when there is no data', async () => {
    const svc = new RequestRateService(fakeRedis());
    expect(await svc.workspaceSnapshot()).toEqual({
      samples: 0,
      histogram: {},
      p50: 0,
      p90: 0,
      p99: 0,
      max: 0,
    });
  });

  it('counts one sample per workspace-minute', async () => {
    const svc = await withCounts({ a: 3, b: 7, c: 1 });
    const snap = await svc.workspaceSnapshot();
    expect(snap.samples).toBe(3);
    expect(snap.max).toBe(7);
  });

  it('puts each workspace-minute in a bucket', async () => {
    const svc = await withCounts({ a: 1, b: 2, c: 4, d: 30 });
    const snap = await svc.workspaceSnapshot();
    // 1→"1", 2→"2", 4→"5", 30→"40"
    expect(snap.histogram).toEqual({ '1': 1, '2': 1, '5': 1, '40': 1 });
  });

  it('reports the percentiles the limit is read off', async () => {
    const counts: Record<string, number> = {};
    // 99 workspaces at 1 request, one at 100: p99 must be the quiet one, max
    // the loud one. A limit set at the MAX would protect nothing; this is the
    // distinction the whole report exists to show.
    for (let i = 0; i < 99; i += 1) counts[`q${i}`] = 1;
    counts.loud = 100;

    const svc = await withCounts(counts);
    const snap = await svc.workspaceSnapshot();

    expect(snap.samples).toBe(100);
    expect(snap.p50).toBe(1);
    expect(snap.p99).toBe(1);
    expect(snap.max).toBe(100);
  });
});

describe('percentile', () => {
  it('is 0 for no samples', () => {
    expect(percentile([], 99)).toBe(0);
  });

  it.each([
    [50, 5],
    [90, 9],
    [99, 10],
    [100, 10],
  ])('p%i of 1..10 is %i', (p, expected) => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], p)).toBe(expected);
  });

  it('never reads past the end of the array', () => {
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([7], 100)).toBe(7);
  });
});

describe('the busiest routes', () => {
  it('reports a route peak and total separately', async () => {
    const redis = fakeRedis();
    const svc = new RequestRateService(redis);

    // Two minutes: 3 then 9. The PEAK is what a per-minute limit is compared
    // against; the total would hide it.
    for (let i = 0; i < 3; i += 1) {
      svc.record({ route: '/quiet' }, new Date('2026-11-19T13:07:00.000Z'));
      await settle();
    }
    for (let i = 0; i < 9; i += 1) {
      svc.record({ route: '/quiet' }, new Date('2026-11-19T13:08:00.000Z'));
      await settle();
    }

    expect(await svc.busiestRoutes()).toEqual([
      { route: '/quiet', peakPerMinute: 9, total: 12 },
    ]);
  });

  it('keeps a route pattern containing colons intact', async () => {
    const redis = fakeRedis();
    const svc = new RequestRateService(redis);

    // The key is `rate:route:<pattern>:<minute>` and the pattern itself has
    // colons in it, so splitting on the first one would truncate the route to
    // "/w" and merge every workspace route into one line.
    svc.record({ route: '/w/:workspaceId/posts/:id' }, AT);
    await settle();

    expect((await svc.busiestRoutes())[0].route).toBe(
      '/w/:workspaceId/posts/:id',
    );
  });

  it('orders by peak, busiest first', async () => {
    const redis = fakeRedis();
    const svc = new RequestRateService(redis);
    for (const [route, n] of [
      ['/a', 2],
      ['/b', 9],
      ['/c', 5],
    ] as const) {
      for (let i = 0; i < n; i += 1) {
        svc.record({ route }, AT);
        await settle();
      }
    }

    expect((await svc.busiestRoutes()).map((r) => r.route)).toEqual([
      '/b',
      '/c',
      '/a',
    ]);
  });

  it('honours the limit', async () => {
    const redis = fakeRedis();
    const svc = new RequestRateService(redis);
    for (const route of ['/a', '/b', '/c']) {
      svc.record({ route }, AT);
      await settle();
    }
    expect(await svc.busiestRoutes(2)).toHaveLength(2);
  });

  it('survives a Redis read failure without throwing', async () => {
    const redis = fakeRedis();
    const svc = new RequestRateService(redis);
    redis.keys = () => Promise.reject(new Error('down'));

    expect(await svc.busiestRoutes()).toEqual([]);
    expect(await svc.workspaceSnapshot()).toEqual({
      samples: 0,
      histogram: {},
      p50: 0,
      p90: 0,
      p99: 0,
      max: 0,
    });
  });
});

describe('the workspace id on a request', () => {
  it.each([
    ['workspaceId', { workspaceId: 'a' }],
    ['wsId', { wsId: 'b' }],
    ['wid', { wid: 'c' }],
  ])('reads :%s', (_label, params) => {
    expect(workspaceIdOf({ params })).toBeTruthy();
  });

  it('prefers :workspaceId when a route carries more than one', () => {
    expect(workspaceIdOf({ params: { workspaceId: 'a', wsId: 'b' } })).toBe(
      'a',
    );
  });

  it.each([
    ['no params at all', undefined],
    ['an empty params bag', {}],
    ['an unrelated param', { id: '9' }],
    ['a blank value', { workspaceId: '   ' }],
  ])('is undefined for %s', (_label, params) => {
    expect(workspaceIdOf({ params })).toBeUndefined();
  });
});
