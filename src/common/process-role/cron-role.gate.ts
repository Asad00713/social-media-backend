import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { processRole, runsCrons, type ProcessRole } from './process-role';

/**
 * Stops scheduled jobs from running on a process whose role is `web`.
 *
 * ## Why crons follow the queues
 *
 * Nearly every cron here exists to enqueue work. A process that does not drain
 * the queue has no business filling it, so `runsCrons` is defined as
 * `runsQueues` rather than as a third switch somebody has to reason about.
 *
 * ## Why the registry, not the 28 job sites
 *
 * Same argument as the cron single-run lock, which wraps `SchedulerRegistry`
 * for exactly this reason (`docs/cron-single-run.md`): with 28 jobs across 23
 * files, the 29th is the one that gets forgotten, and nothing fails visibly
 * when it is.
 *
 * ## This does NOT replace the cron lock
 *
 * The lock is still required. A rolling deploy briefly runs two worker
 * containers, and both would fire every cron — which is the token-refresh race
 * the lock exists to prevent. This gate decides *which kind of process* runs
 * crons at all; the lock decides *which copy* runs a given tick.
 *
 * Stopping is enough — the jobs stay registered, so nothing else that reads
 * the registry (including the lock's own bootstrap logging) changes shape.
 */
@Injectable()
export class CronRoleGate implements OnApplicationBootstrap {
  private readonly logger = new Logger(CronRoleGate.name);

  constructor(private readonly registry: SchedulerRegistry) {}

  onApplicationBootstrap(): void {
    const role = processRole();
    if (runsCrons(role)) {
      this.logger.log(`Role '${role}': cron jobs active`);
      return;
    }
    this.stopAll(role);
  }

  private stopAll(role: ProcessRole): void {
    const jobs = this.registry.getCronJobs();
    let stopped = 0;
    const failed: string[] = [];

    for (const [name, job] of jobs) {
      try {
        job.stop();
        stopped += 1;
      } catch {
        failed.push(name);
      }
    }

    this.logger.log(
      `Role '${role}': stopped ${stopped} of ${jobs.size} cron job(s)`,
    );
    if (failed.length > 0) {
      // Loud: a cron still running here is a cron running in two roles.
      this.logger.error(
        `Role '${role}': could not stop ${failed.length} cron(s): ${failed.join(', ')}`,
      );
    }
  }
}
