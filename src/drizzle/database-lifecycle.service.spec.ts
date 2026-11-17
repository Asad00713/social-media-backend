import { Injectable, BeforeApplicationShutdown } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DatabaseLifecycleService } from './database-lifecycle.service';

function makePool() {
  return { end: jest.fn(() => Promise.resolve()) };
}

describe('DatabaseLifecycleService', () => {
  it('closes the pool on shutdown', async () => {
    const pool = makePool();
    await new DatabaseLifecycleService(pool as never).onApplicationShutdown();
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  /**
   * A second signal (or a close that races a signal) must not turn a tidy
   * shutdown into a crash. node-postgres rejects a second `end()` with
   * "Called end on pool more than once".
   */
  it('is idempotent — a second shutdown neither ends again nor throws', async () => {
    const pool = makePool();
    const service = new DatabaseLifecycleService(pool as never);

    await service.onApplicationShutdown();
    await expect(service.onApplicationShutdown()).resolves.toBeUndefined();

    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  /**
   * A pool that fails to drain must not abort the rest of the shutdown
   * sequence — the remaining hooks still need to run.
   */
  it('never rejects when the pool fails to close', async () => {
    const pool = {
      end: jest.fn(() => Promise.reject(new Error('already ended'))),
    };
    const service = new DatabaseLifecycleService(pool as never);
    await expect(service.onApplicationShutdown()).resolves.toBeUndefined();
  });

  /**
   * The ordering invariant. Queries run until the workers stop, so the pool
   * must outlive the drain phase — exactly like the Redis clients. Closing it
   * in `beforeApplicationShutdown` would pull the database out from under a
   * job that is still finishing.
   */
  /*
   * Booting a Nest app costs seconds on a loaded machine — this has been
   * measured at 4.5s against Jest's 5s default, so it fails as a timeout
   * rather than on its assertion. A flaky ordering test is worse than none:
   * people learn to re-run it instead of reading it. The limit is raised to
   * leave headroom; the test still fails fast on the thing it checks, because
   * a wrong order returns immediately.
   */
  it('closes the pool only after the worker-drain phase', async () => {
    const order: string[] = [];
    const pool = {
      end: jest.fn(async () => {
        order.push('pool-closed');
      }),
    };

    @Injectable()
    class FakeWorkerHost implements BeforeApplicationShutdown {
      async beforeApplicationShutdown(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push('workers-closed');
      }
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        FakeWorkerHost,
        {
          provide: DatabaseLifecycleService,
          useValue: new DatabaseLifecycleService(pool as never),
        },
      ],
    }).compile();

    const app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();
    await app.close();

    expect(order).toEqual(['workers-closed', 'pool-closed']);
  }, 30_000);
});
