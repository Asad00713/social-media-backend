import type { ConfigService } from '@nestjs/config';
import { Injectable, BeforeApplicationShutdown } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService as NestConfigService } from '@nestjs/config';
import { RateLimiterService } from './rate-limiter.service';

/** The client the service builds; replaced so no test opens a connection. */
const redis = {
  status: 'ready',
  quit: jest.fn(() => Promise.resolve('OK')),
  disconnect: jest.fn(),
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
  });
});
