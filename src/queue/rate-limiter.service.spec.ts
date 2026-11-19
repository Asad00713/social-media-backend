import type { ConfigService } from '@nestjs/config';
import { Injectable, BeforeApplicationShutdown } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService as NestConfigService } from '@nestjs/config';
import {
  PLATFORM_RATE_LIMITS,
  PER_CHANNEL_LIMITS,
  RUNAWAY_LIMIT_PER_WINDOW,
  RateLimiterService,
} from './rate-limiter.service';

/** The client the service builds; replaced so no test opens a connection. */
const redis = {
  status: 'ready',
  quit: jest.fn(() => Promise.resolve('OK')),
  disconnect: jest.fn(),
  // The sorted-set commands the limit checks drive. Defaults say "window
  // empty", so a check passes unless a test says otherwise.
  zremrangebyscore: jest.fn(() => Promise.resolve(0)),
  zcard: jest.fn(() => Promise.resolve(0)),
  zrange: jest.fn(() => Promise.resolve([] as string[])),
  zadd: jest.fn(() => Promise.resolve(1)),
  expire: jest.fn(() => Promise.resolve(1)),
};
jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn(() => redis),
}));

function make(status: string): RateLimiterService {
  redis.status = status;
  return new RateLimiterService({
    get: (_key: string, fallback: unknown) => fallback,
  } as unknown as ConfigService);
}

beforeEach(() => {
  redis.quit.mockClear();
  redis.disconnect.mockClear();
  redis.status = 'ready';
  redis.zremrangebyscore.mockReset().mockResolvedValue(0);
  redis.zcard.mockReset().mockResolvedValue(0);
  redis.zrange.mockReset().mockResolvedValue([]);
});

describe('RateLimiterService shutdown', () => {
  it('quits a ready connection', async () => {
    await make('ready').onApplicationShutdown();
    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(redis.disconnect).not.toHaveBeenCalled();
  });

  it('drops a connection that is not ready instead of queueing QUIT', async () => {
    await make('reconnecting').onApplicationShutdown();
    expect(redis.quit).not.toHaveBeenCalled();
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });

  it('falls back to disconnect when QUIT fails, and never rejects', async () => {
    const service = make('ready');
    redis.quit.mockRejectedValueOnce(new Error('Connection is closed.'));
    await expect(service.onApplicationShutdown()).resolves.toBeUndefined();
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });

  /**
   * The bug this file exists for.
   *
   * This client serves the publish path's rate-limit checks. @nestjs/bullmq
   * closes its workers in `onApplicationShutdown`, and Nest runs every
   * `onModuleDestroy` *before* that — so a cleanup hook named
   * `onModuleDestroy` kills this connection while workers are still taking
   * jobs. A publish could then succeed at the platform, fail its own
   * bookkeeping, be marked failed, and double-post on retry.
   *
   * Asserting the hook *name* is the invariant: renaming it back to
   * `onModuleDestroy` is exactly the regression, and it must fail here.
   */
  it('cleans up in onApplicationShutdown, so BullMQ workers close first', () => {
    const service = make('ready');
    expect(typeof service.onApplicationShutdown).toBe('function');
    expect(
      (service as Partial<Record<'onModuleDestroy', unknown>>).onModuleDestroy,
    ).toBeUndefined();
  });

  /**
   * The ordering itself, driven through a real Nest container.
   *
   * Asserting only "Nest called our hook" is not enough: `onModuleDestroy`
   * fires on `app.close()` too, so that assertion passes just as happily
   * against the bug. What must hold is the *order* — no job may still be
   * running when this connection goes away.
   *
   * Nest awaits each shutdown phase before starting the next, but runs the
   * hooks *within* a phase through `Promise.all`. So the guarantee comes from
   * the phases being different, not from registration order: workers drain in
   * `beforeApplicationShutdown` (see WorkerDrainService) and Redis closes in
   * `onApplicationShutdown`. The stand-in below drains in that earlier phase,
   * exactly as WorkerDrainService does.
   */
  it('closes Redis only after the worker-drain phase has finished', async () => {
    const order: string[] = [];

    @Injectable()
    class FakeWorkerHost implements BeforeApplicationShutdown {
      async beforeApplicationShutdown(): Promise<void> {
        // Asynchronous on purpose: a drain that yields must still complete
        // before the next phase starts, or the guarantee is not a guarantee.
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push('workers-closed');
      }
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        RateLimiterService,
        FakeWorkerHost,
        {
          provide: NestConfigService,
          useValue: { get: (_k: string, fallback: unknown) => fallback },
        },
      ],
    }).compile();

    const app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();

    redis.quit.mockClear();
    redis.quit.mockImplementation(() => {
      order.push('redis-quit');
      return Promise.resolve('OK');
    });

    await app.close();

    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['workers-closed', 'redis-quit']);
    // Booting a Nest app costs seconds on a loaded machine, and this has been
    // measured past Jest's 5s default. A flaky ordering test is worse than
    // none: people re-run it instead of reading it. A wrong order still fails
    // immediately, so the headroom costs nothing.
  }, 30_000);
});

/**
 * The scope bug.
 *
 * `PLATFORM_RATE_LIMITS` was built from the platforms' own published numbers —
 * its comments said so ("Instagram is very strict: 25 per 24 hours") — and
 * those numbers are PER CONNECTED ACCOUNT. They were counted in one Redis key
 * shared by every customer, so Instagram's per-account allowance of 25 was
 * enforced as 20 posts per day across the whole app. Fifty customers shared
 * one customer's budget, and each of them was refused for reasons none of them
 * caused.
 *
 * The app-wide counter is kept, but only as a brake on a runaway loop that
 * could get the whole app banned from a platform. That is a real risk and it
 * is genuinely app-wide; it is simply not anyone's quota. Asserting every
 * entry equals the brake is what stops a per-account number drifting back in.
 */
describe('the app-wide limit is a runaway brake, not a customer quota', () => {
  it('is the same high ceiling for every platform', () => {
    for (const [platform, limit] of Object.entries(PLATFORM_RATE_LIMITS)) {
      expect({ platform, max: limit.maxRequests }).toEqual({
        platform,
        max: RUNAWAY_LIMIT_PER_WINDOW,
      });
    }
  });

  it('sits far above the most generous per-channel cap', () => {
    const highestPerChannel = Math.max(
      ...Object.values(PER_CHANNEL_LIMITS).map((l) => l.maxRequests),
    );
    expect(RUNAWAY_LIMIT_PER_WINDOW).toBeGreaterThan(highestPerChannel * 10);
  });

  /**
   * Redis is not on the critical path for correctness here: refusing to
   * publish because the limiter cannot be reached would turn a Redis blip into
   * failed posts. `getRateLimitStatus` already degrades this way, so the check
   * matches it rather than inventing a second policy.
   */
  it('treats an unreachable Redis as allowed rather than throwing', async () => {
    redis.zremrangebyscore.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(
      make('ready').checkRateLimit('instagram'),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('still refuses once the brake is genuinely reached', async () => {
    redis.zcard.mockResolvedValueOnce(RUNAWAY_LIMIT_PER_WINDOW);
    redis.zrange.mockResolvedValueOnce(['id', String(Date.now())]);
    const result = await make('ready').checkRateLimit('instagram');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });
});

/**
 * Per-channel is the correct denominator: the platform limits one connected
 * account. These numbers were also stricter than the platforms allow (Buffer
 * publishes 50/day for Instagram and 25/day for TikTok), so a customer was
 * throttled twice — once by a cap that was not theirs, once early.
 */
describe('per-channel caps', () => {
  it.each([
    ['instagram', 50, 24 * 60 * 60 * 1000],
    ['tiktok', 25, 24 * 60 * 60 * 1000],
    ['twitter', 50, 60 * 60 * 1000],
  ])('allows %s %i per window', (platform, maxRequests, windowMs) => {
    expect(PER_CHANNEL_LIMITS[platform as keyof typeof PER_CHANNEL_LIMITS]).toEqual(
      { maxRequests, windowMs },
    );
  });

  /**
   * Relaxing the three platforms that already restrict is this change.
   * Starting to restrict one that does not is a different decision, and it
   * would silently cap customers who are not capped today.
   */
  it('adds no per-channel cap where there was none', () => {
    expect(Object.keys(PER_CHANNEL_LIMITS).sort()).toEqual([
      'instagram',
      'tiktok',
      'twitter',
    ]);
  });

  it('does not limit a platform that has no per-channel cap', async () => {
    const result = await make('ready').checkChannelRateLimit('mastodon', 'ch-1');
    expect(result.allowed).toBe(true);
  });
});
