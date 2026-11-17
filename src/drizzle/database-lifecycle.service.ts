import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';

/** Injection token for the pool a DatabaseLifecycleService is responsible for. */
export const MANAGED_POOL = 'MANAGED_POOL';

/**
 * Drains a Postgres connection pool when the application shuts down.
 *
 * Without this the pool's sockets stay open through shutdown: Node keeps the
 * process alive waiting on them until the platform loses patience and sends
 * SIGKILL, which is precisely the ungraceful exit the shutdown hooks exist to
 * avoid. Postgres is left reaping the abandoned backends.
 *
 * Closes in `onApplicationShutdown`, the same phase as the Redis clients and
 * one phase after WorkerDrainService stops the BullMQ workers. Queries run
 * until the workers stop, so the pool has to outlive the drain — closing it
 * earlier would pull the database out from under a job that is still
 * finishing. See WorkerDrainService for why the phase split is the guarantee.
 */
@Injectable()
export class DatabaseLifecycleService implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseLifecycleService.name);
  private closed = false;

  constructor(@Inject(MANAGED_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    // node-postgres rejects a second end() with "Called end on pool more than
    // once", and a double signal is ordinary — guard rather than let a tidy
    // shutdown end in an unhandled rejection.
    if (this.closed) return;
    this.closed = true;

    try {
      await this.pool.end();
      this.logger.log('Postgres pool closed');
    } catch (error) {
      // A pool that will not drain must not abort the rest of the shutdown
      // sequence; the remaining hooks still have work to do.
      this.logger.warn(
        `Postgres pool did not close cleanly: ${(error as Error).message}`,
      );
    }
  }
}
