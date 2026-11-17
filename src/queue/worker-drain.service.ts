import { Injectable, Logger, BeforeApplicationShutdown } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { WorkerHost } from '@nestjs/bullmq';
import type { Worker } from 'bullmq';

/**
 * Closes every BullMQ worker in the `beforeApplicationShutdown` phase, so
 * in-flight jobs finish before anything they depend on is torn down.
 *
 * ## Why this exists
 *
 * `@nestjs/bullmq` already closes its workers — but in `onApplicationShutdown`,
 * the same phase in which our Redis clients close. Nest runs the hooks within
 * one phase through `Promise.all`, so those are concurrent: a worker can still
 * be mid-job when the rate limiter's Redis connection goes away. A publish then
 * reaches the platform, fails its own bookkeeping against a closed client, is
 * marked failed, and double-posts on retry.
 *
 * Nest's phases themselves are sequential and awaited:
 *
 * ```
 * onModuleDestroy  →  beforeApplicationShutdown  →  dispose  →  onApplicationShutdown
 * ```
 *
 * Closing the workers one phase earlier therefore gives a real ordering
 * guarantee rather than a race we happen to win. By the time Redis closes, no
 * job is running. `@nestjs/bullmq`'s own hook still fires afterwards and finds
 * the workers already closed, which is a no-op — `Worker.close()` is idempotent.
 *
 * ## Why discovery rather than injecting the workers
 *
 * The workers live inside `@nestjs/bullmq`'s private explorer, which is not
 * exported. Every processor extends `WorkerHost`, though, and that exposes its
 * own `worker` — so asking the container for the `WorkerHost` instances reaches
 * all of them without depending on the library's internals. A processor that is
 * registered but never started has no worker yet; those are skipped.
 */
@Injectable()
export class WorkerDrainService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(WorkerDrainService.name);

  constructor(private readonly discovery: DiscoveryService) {}

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    const workers = this.collectWorkers();
    if (workers.length === 0) return;

    this.logger.log(
      `${signal ?? 'shutdown'}: draining ${workers.length} BullMQ worker(s) before closing connections`,
    );

    // Settled, not all: one worker failing to close must not abandon the rest
    // and leave their jobs running into the Redis teardown.
    const results = await Promise.allSettled(
      workers.map((worker) => worker.close()),
    );

    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      this.logger.warn(`${failed} worker(s) did not close cleanly`);
    } else {
      this.logger.log('All BullMQ workers drained');
    }
  }

  private collectWorkers(): Worker[] {
    return this.discovery
      .getProviders()
      .map((wrapper) => wrapper.instance)
      .filter(
        (instance): instance is WorkerHost =>
          instance instanceof WorkerHost &&
          // `worker` throws if the processor was never started.
          this.hasWorker(instance),
      )
      .map((host) => host.worker);
  }

  private hasWorker(host: WorkerHost): boolean {
    try {
      return !!host.worker;
    } catch {
      return false;
    }
  }
}
