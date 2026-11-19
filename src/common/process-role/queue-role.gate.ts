import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { WorkerHost } from '@nestjs/bullmq';
import type { Worker } from 'bullmq';
import { processRole, runsQueues, type ProcessRole } from './process-role';

/**
 * Stops BullMQ workers from running on a process whose role is `web`.
 *
 * ## Why discovery, and not 24 edits
 *
 * There are 24 `@Processor` classes across 24 files. Gating each one means the
 * 25th is the one somebody forgets, and NOTHING FAILS when they do — the
 * symptom is a web process quietly draining a queue months later, which is the
 * isolation this whole change exists to buy.
 *
 * Every processor extends `WorkerHost`, which exposes its own `worker`, so
 * asking the container for `WorkerHost` instances reaches all of them —
 * including ones added later — without touching the library's internals. This
 * is the same mechanism `WorkerDrainService` already uses in this codebase,
 * and the same argument as the cron lock wrapping `SchedulerRegistry` rather
 * than 28 job sites (`docs/cron-single-run.md`).
 *
 * ## Why pause rather than close
 *
 * `close()` is terminal: the shutdown path uses it, and a closed worker cannot
 * be revived. `pause(true)` stops this worker taking new jobs while leaving the
 * instance intact, so `WorkerDrainService` still finds it at shutdown and the
 * behaviour of every other path is unchanged.
 *
 * `true` means "do not wait for active jobs" — at bootstrap there are none, and
 * waiting would block startup behind a queue we are trying not to serve.
 *
 * ## Fails open, loudly
 *
 * A worker that cannot be paused is logged as an error and left running. A web
 * process that also drains a queue is today's behaviour and costs latency; a
 * process that refuses to boot costs the whole service.
 */
@Injectable()
export class QueueRoleGate implements OnApplicationBootstrap {
  private readonly logger = new Logger(QueueRoleGate.name);

  constructor(private readonly discovery: DiscoveryService) {}

  async onApplicationBootstrap(): Promise<void> {
    const role = processRole();
    if (runsQueues(role)) {
      this.logger.log(`Role '${role}': BullMQ workers active`);
      return;
    }
    await this.pauseAll(role);
  }

  private async pauseAll(role: ProcessRole): Promise<void> {
    const workers = this.collectWorkers();
    if (workers.length === 0) {
      // Worth seeing: it means this ran before the workers existed, so the
      // queues are being served by a process that should not serve them.
      this.logger.warn(
        `Role '${role}': no BullMQ workers found to pause — queues may still be served here`,
      );
      return;
    }

    const results = await Promise.allSettled(
      workers.map((worker) => worker.pause(true)),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;

    this.logger.log(
      `Role '${role}': paused ${workers.length - failed} of ${workers.length} BullMQ worker(s)`,
    );
    if (failed > 0) {
      this.logger.error(
        `Role '${role}': ${failed} worker(s) could not be paused and will keep taking jobs`,
      );
    }
  }

  private collectWorkers(): Worker[] {
    return this.discovery
      .getProviders()
      .map((wrapper) => wrapper.instance)
      .filter(
        (instance): instance is WorkerHost =>
          instance instanceof WorkerHost && this.hasWorker(instance),
      )
      .map((host) => host.worker);
  }

  /** `worker` throws if the processor was never started. */
  private hasWorker(host: WorkerHost): boolean {
    try {
      return !!host.worker;
    } catch {
      return false;
    }
  }
}
