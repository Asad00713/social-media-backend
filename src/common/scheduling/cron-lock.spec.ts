import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CronJob } from 'cron';
import {
  CronLockBootstrap,
  lockTtlMs,
  MAX_LOCK_TTL_MS,
  MIN_LOCK_TTL_MS,
  tickIntervalMs,
} from './cron-lock.bootstrap';
import {
  ACQUIRE_TIMEOUT_MS,
  CronLockService,
  type CronLockRedis,
} from './cron-lock.service';

/**
 * One run per tick, across every process.
 *
 * `ScheduleModule.forRoot()` is in `AppModule`, so every process that boots
 * the app runs all 28 crons. Harmless with one process; the blocker for
 * splitting web from worker. The job that must not double-fire is
 * `token-refresh.scheduler`, which enqueues a refresh per channel with no
 * `jobId` — and several platforms invalidate the old refresh token when it is
 * exchanged, so two concurrent refreshes can race into a token the platform no
 * longer accepts.
 */

interface FakeRedis extends CronLockRedis {
  keys: Map<string, { value: string; ttlMs: number }>;
  failWith?: Error;
  hang?: boolean;
  /**
   * Present even though `CronLockRedis` does not declare it.
   *
   * The lock must NOT release on completion, and a fake without `del` cannot
   * tell: a mutation adding a release call was a silent no-op against it and
   * all 36 tests stayed green. A fake has to be able to perform the mistake it
   * is meant to catch.
   */
  del(key: string): Promise<number>;
}

function fakeRedis(): FakeRedis {
  const keys = new Map<string, { value: string; ttlMs: number }>();
  const self: FakeRedis = {
    keys,
    set(key, value, _mode, ttlMs, _flag) {
      if (self.failWith) return Promise.reject(self.failWith);
      if (self.hang) return new Promise(() => undefined);
      // SET … NX: only when absent.
      if (keys.has(key)) return Promise.resolve(null);
      keys.set(key, { value, ttlMs });
      return Promise.resolve('OK');
    },
    del(key) {
      const had = keys.delete(key);
      return Promise.resolve(had ? 1 : 0);
    },
  };
  return self;
}

describe('claiming a tick', () => {
  it('runs the job for the process that claims it', async () => {
    const svc = new CronLockService(fakeRedis());
    let ran = 0;

    const out = await svc.runOnce('nightly', 1000, () => {
      ran += 1;
      return Promise.resolve('done');
    });

    expect(out).toEqual({ ran: true, result: 'done' });
    expect(ran).toBe(1);
  });

  it('skips the job on every other process in the same tick', async () => {
    const redis = fakeRedis();
    // Two services sharing one Redis is exactly the web/worker split.
    const web = new CronLockService(redis);
    const worker = new CronLockService(redis);
    let ran = 0;
    const job = () => {
      ran += 1;
      return Promise.resolve();
    };

    const first = await web.runOnce('tokenRefresh', 1000, job);
    const second = await worker.runOnce('tokenRefresh', 1000, job);

    expect(first.ran).toBe(true);
    expect(second.ran).toBe(false);
    expect(ran).toBe(1);
  });

  it('keeps different jobs independent', async () => {
    const redis = fakeRedis();
    const svc = new CronLockService(redis);

    expect((await svc.runOnce('a', 1000, () => Promise.resolve())).ran).toBe(
      true,
    );
    expect((await svc.runOnce('b', 1000, () => Promise.resolve())).ran).toBe(
      true,
    );
  });

  it('does not release the lock when the job finishes', async () => {
    const redis = fakeRedis();
    const svc = new CronLockService(redis);

    await svc.runOnce('nightly', 1000, () => Promise.resolve());
    const again = await svc.runOnce('nightly', 1000, () => Promise.resolve());

    // This is "once per tick", not "one at a time". Releasing on completion
    // would let the other process pick up the SAME tick and run it again — the
    // duplicate this whole file exists to prevent.
    expect(again.ran).toBe(false);
    expect(redis.keys.size).toBe(1);
  });

  it('passes the job name into the key, not a shared one', async () => {
    const redis = fakeRedis();
    await new CronLockService(redis).runOnce('postPurge', 1000, () =>
      Promise.resolve(),
    );

    const key = [...redis.keys.keys()][0];
    expect(key).toContain('postPurge');
  });

  it('lets the job throw rather than swallowing it', async () => {
    const svc = new CronLockService(fakeRedis());

    // Each cron handles its own errors (and Nest logs an unhandled one). A
    // lock that swallowed them would hide a broken job behind "it ran".
    await expect(
      svc.runOnce('boom', 1000, () => Promise.reject(new Error('job failed'))),
    ).rejects.toThrow('job failed');
  });
});

describe('it fails CLOSED when Redis is unreachable', () => {
  it('skips the job rather than running it everywhere', async () => {
    const redis = fakeRedis();
    redis.failWith = new Error('ECONNREFUSED');
    const svc = new CronLockService(redis);
    let ran = 0;

    const out = await svc.runOnce('tokenRefresh', 1000, () => {
      ran += 1;
      return Promise.resolve();
    });

    // The asymmetry that decides this: a missed nightly purge is invisible and
    // the next tick retries it. A double token refresh disconnects a
    // customer's channel.
    expect(out.ran).toBe(false);
    expect(ran).toBe(0);
  });

  it('says why, and that the next tick will retry', async () => {
    const redis = fakeRedis();
    redis.failWith = new Error('ECONNREFUSED');
    const svc = new CronLockService(redis);
    const warn = jest
      .spyOn(
        (svc as unknown as { logger: { warn: (m: string) => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    await svc.runOnce('postPurge', 1000, () => Promise.resolve());

    expect(warn.mock.calls[0]?.[0]).toMatch(/postPurge/);
    expect(warn.mock.calls[0]?.[0]).toMatch(/next tick/i);
    warn.mockRestore();
  });

  it('does not wait forever on a hung Redis', async () => {
    jest.useFakeTimers();
    const redis = fakeRedis();
    redis.hang = true;
    const svc = new CronLockService(redis);
    jest
      .spyOn(
        (svc as unknown as { logger: { warn: (m: string) => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    const pending = svc.runOnce('nightly', 1000, () => Promise.resolve());
    jest.advanceTimersByTime(ACQUIRE_TIMEOUT_MS + 10);
    const out = await pending;

    // ioredis holds a command for a connection that is not coming, so without
    // this bound a hung Redis would hold the tick open indefinitely.
    expect(out.ran).toBe(false);
    jest.useRealTimers();
  });
});

describe('the TTL comes from each job’s own schedule', () => {
  it.each([
    ['*/30 * * * * *', 30_000],
    ['0 * * * * *', 60_000],
    ['*/5 * * * *', 300_000],
    ['*/10 * * * *', 600_000],
    ['*/15 * * * *', 900_000],
    ['15 * * * *', 3_600_000],
    ['0 0 * * *', 86_400_000],
    ['0 4 * * 0', 604_800_000],
  ])('reads %s as a %pms interval', (expr, expected) => {
    const job = new CronJob(expr, () => undefined, null, false, 'UTC');
    expect(tickIntervalMs(job as never)).toBe(expected);
  });

  it('measures the gap between ticks, not the time until the next one', () => {
    // These differ, and only the first is the interval: a daily midnight job
    // read at 05:00 is 19h from its next tick but 24h between ticks. A TTL
    // built from time-until-next would be wrong on every run.
    const daily = new CronJob('0 0 * * *', () => undefined, null, false, 'UTC');
    const untilNext =
      (daily.nextDate() as unknown as { toMillis: () => number }).toMillis() -
      Date.now();

    expect(tickIntervalMs(daily as never)).toBe(86_400_000);
    expect(tickIntervalMs(daily as never)).not.toBe(untilNext);
  });

  it.each([
    [30_000, 15_000],
    [600_000, 300_000],
    [900_000, 450_000],
  ])('halves a %pms interval to %pms', (interval, expected) => {
    expect(lockTtlMs(interval)).toBe(expected);
  });

  it('never lets the TTL reach the interval', () => {
    // At or above the interval, the key is still held when the next tick
    // arrives and that tick is skipped on EVERY process — turning a safety
    // measure into a job that silently stops running.
    for (const interval of [30_000, 60_000, 300_000, 900_000, 3_600_000]) {
      expect(lockTtlMs(interval)).toBeLessThan(interval);
    }
  });

  it('floors short intervals so a slow poller cannot double-run', () => {
    expect(lockTtlMs(1000)).toBe(MIN_LOCK_TTL_MS);
    expect(lockTtlMs(0)).toBe(MIN_LOCK_TTL_MS);
  });

  it('caps long intervals so one failure cannot skip a week', () => {
    // A weekly job with a half-interval TTL would hold its key for 3.5 days.
    expect(lockTtlMs(604_800_000)).toBe(MAX_LOCK_TTL_MS);
    expect(MAX_LOCK_TTL_MS).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it('returns null for a job it cannot read a schedule from', () => {
    expect(tickIntervalMs({} as never)).toBeNull();
    expect(tickIntervalMs({ cronTime: {} } as never)).toBeNull();
  });
});

describe('wrapping every registered job', () => {
  function registryOf(jobs: Map<string, unknown>) {
    return {
      getCronJobs: () => jobs,
    } as unknown as ConstructorParameters<typeof CronLockBootstrap>[0];
  }

  function jobWithCallback(expr: string, onTick: () => void) {
    return new CronJob(expr, onTick, null, false, 'UTC');
  }

  /**
   * Fires a tick and lets the wrapper's own async work finish.
   *
   * `fireOnTick` does NOT await its callbacks, so the lock's Redis round trip
   * is a microtask and the job body runs after it. Measured: `ran` is still 0
   * immediately after `fireOnTick()` and 1 once microtasks drain. That is fine
   * in production — the job runs, just a tick of the event loop later — but a
   * test that asserts straight after the call is reading the wrong moment.
   */
  async function fire(job: CronJob): Promise<void> {
    await job.fireOnTick();
    await new Promise((r) => setImmediate(r));
  }

  it('wraps a job so its tick goes through the lock', async () => {
    const redis = fakeRedis();
    const lock = new CronLockService(redis);
    let ran = 0;
    const job = jobWithCallback('*/5 * * * *', () => {
      ran += 1;
    });
    const jobs = new Map<string, unknown>([['poller', job]]);

    new CronLockBootstrap(registryOf(jobs), lock).onApplicationBootstrap();
    await fire(job);

    expect(ran).toBe(1);
    expect([...redis.keys.keys()]).toEqual(['cron-lock:poller']);
  });

  it('still runs the original handler, not a replacement', async () => {
    const lock = new CronLockService(fakeRedis());
    const seen: string[] = [];
    const job = jobWithCallback('*/5 * * * *', () => {
      seen.push('original');
    });

    new CronLockBootstrap(
      registryOf(new Map<string, unknown>([['j', job]])),
      lock,
    ).onApplicationBootstrap();
    await fire(job);

    expect(seen).toEqual(['original']);
  });

  it('stops the second process from running the same tick', async () => {
    const redis = fakeRedis();
    let ran = 0;
    const handler = () => {
      ran += 1;
    };

    // Two processes, one Redis, same job name — the web/worker split.
    for (const _ of [0, 1]) {
      const job = jobWithCallback('*/10 * * * *', handler);
      new CronLockBootstrap(
        registryOf(new Map<string, unknown>([['tokenRefresh', job]])),
        new CronLockService(redis),
      ).onApplicationBootstrap();
      await fire(job);
    }

    expect(ran).toBe(1);
  });

  it('wraps every job in the registry, not just the first', async () => {
    const redis = fakeRedis();
    const lock = new CronLockService(redis);
    const jobs = new Map<string, unknown>([
      ['a', jobWithCallback('*/5 * * * *', () => undefined)],
      ['b', jobWithCallback('0 0 * * *', () => undefined)],
      ['c', jobWithCallback('*/30 * * * * *', () => undefined)],
    ]);

    new CronLockBootstrap(registryOf(jobs), lock).onApplicationBootstrap();
    for (const job of jobs.values()) await fire(job as CronJob);

    expect([...redis.keys.keys()].sort()).toEqual([
      'cron-lock:a',
      'cron-lock:b',
      'cron-lock:c',
    ]);
  });

  it('gives each job a TTL from its own schedule', async () => {
    const redis = fakeRedis();
    const lock = new CronLockService(redis);
    const jobs = new Map<string, unknown>([
      ['fast', jobWithCallback('*/30 * * * * *', () => undefined)],
      ['slow', jobWithCallback('*/10 * * * *', () => undefined)],
    ]);

    new CronLockBootstrap(registryOf(jobs), lock).onApplicationBootstrap();
    for (const job of jobs.values()) await fire(job as CronJob);

    // Not one hand-picked number for all of them: 30s → 15s, 10min → 5min.
    expect(redis.keys.get('cron-lock:fast')?.ttlMs).toBe(15_000);
    expect(redis.keys.get('cron-lock:slow')?.ttlMs).toBe(300_000);
  });

  it('reports how many it wrapped, so a bad import order is visible', () => {
    const lock = new CronLockService(fakeRedis());
    const jobs = new Map<string, unknown>([
      ['a', jobWithCallback('*/5 * * * *', () => undefined)],
    ]);
    const boot = new CronLockBootstrap(registryOf(jobs), lock);
    const log = jest
      .spyOn(
        (boot as unknown as { logger: { log: (m: string) => void } }).logger,
        'log',
      )
      .mockImplementation(() => undefined);

    boot.onApplicationBootstrap();

    // A count of 0 means this ran before ScheduleModule registered anything,
    // leaving every cron unprotected. Worth seeing in the logs rather than
    // inferring from a duplicate run weeks later.
    expect(log.mock.calls[0]?.[0]).toMatch(/1 of 1/);
    log.mockRestore();
  });

  it('shouts about a job it could not wrap', () => {
    const lock = new CronLockService(fakeRedis());
    // No callbacks: nothing to wrap, so this job WILL double-fire.
    const jobs = new Map<string, unknown>([['opaque', { cronTime: {} }]]);
    const boot = new CronLockBootstrap(registryOf(jobs), lock);
    const error = jest
      .spyOn(
        (boot as unknown as { logger: { error: (m: string) => void } }).logger,
        'error',
      )
      .mockImplementation(() => undefined);

    boot.onApplicationBootstrap();

    expect(error.mock.calls[0]?.[0]).toMatch(/opaque/);
    expect(error.mock.calls[0]?.[0]).toMatch(/every process/i);
    error.mockRestore();
  });

  it('survives an empty registry', () => {
    const boot = new CronLockBootstrap(
      registryOf(new Map()),
      new CronLockService(fakeRedis()),
    );
    expect(() => boot.onApplicationBootstrap()).not.toThrow();
  });
});

/**
 * A net over the real cron list rather than a copy of it, because the failure
 * mode here is a job nobody remembered — the same shape as BE #251 and #252,
 * where what was missing was a line, not a wrong one.
 */
describe('every cron in the app is covered', () => {
  const appModule = readFileSync(
    join(__dirname, '..', '..', 'app.module.ts'),
    'utf8',
  );

  it('registers SchedulingModule', () => {
    expect(appModule).toMatch(/SchedulingModule,/);
  });

  it('registers it AFTER ScheduleModule.forRoot()', () => {
    // The wrap reads the jobs ScheduleModule registers; before it, there are
    // none to read and every cron is left unprotected.
    const schedule = appModule.indexOf('ScheduleModule.forRoot()');
    const scheduling = appModule.indexOf('SchedulingModule,');
    expect(schedule).toBeGreaterThan(-1);
    expect(scheduling).toBeGreaterThan(schedule);
  });

  it('covers crons by wrapping the registry, not by decorating job sites', () => {
    // 28 jobs across 23 files: a per-site decorator makes the 29th the one
    // somebody forgets, and nothing fails when they do.
    const bootstrap = readFileSync(
      join(__dirname, 'cron-lock.bootstrap.ts'),
      'utf8',
    );
    expect(bootstrap).toMatch(/getCronJobs\(\)/);
  });
});
