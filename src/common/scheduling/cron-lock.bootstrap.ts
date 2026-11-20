import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronLockService } from './cron-lock.service';

/**
 * A cron job's tick callbacks, which the `cron` package keeps in a private
 * array. Probed rather than assumed: a `CronJob` built from a function exposes
 * `_callbacks: [fn]`, and replacing the entry changes what the tick runs
 * (verified — the replacement runs, and calling through still runs the
 * original).
 *
 * Deliberately a standalone shape, NOT `CronJob & {...}`. `_callbacks` is
 * `private` on `CronJob`, and an intersection that redeclares a private
 * property collapses to `never` (TS2339: *"the intersection was reduced to
 * never because '_callbacks' exists in multiple constituents and is private in
 * some"*). Jest does not typecheck, so that error only appears in
 * `npm run typecheck` / the build.
 */
interface WrappableCronJob {
  _callbacks?: Array<(...args: unknown[]) => unknown>;
  cronTime?: { source?: unknown; getNextDateFrom?: (d: Date) => unknown };
}

/** Milliseconds between two consecutive ticks of a schedule. */
export function tickIntervalMs(job: WrappableCronJob): number | null {
  const cronTime = job.cronTime;
  if (!cronTime?.getNextDateFrom) return null;
  try {
    // Deliberately the gap between the NEXT two ticks, not "time until the
    // next tick" — those differ, and only the first is the interval. For a
    // daily job at midnight read at 05:00, time-until-next is 19h while the
    // interval is 24h, and a TTL built from 19h would be wrong every run.
    const first = toMillis(cronTime.getNextDateFrom(new Date()));
    if (first === null) return null;
    const second = toMillis(cronTime.getNextDateFrom(new Date(first + 1000)));
    if (second === null) return null;
    const interval = second - first;
    return interval > 0 ? interval : null;
  } catch {
    return null;
  }
}

function toMillis(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  const asLuxon = value as { toMillis?: () => number } | null;
  if (typeof asLuxon?.toMillis === 'function') {
    const ms = asLuxon.toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * How long a claimed tick stays claimed.
 *
 * Half the interval, bounded. The TTL has to satisfy two things at once:
 *
 *  - **longer than the job's runtime**, or a slow job's own second process
 *    could claim the same tick while the first is still working;
 *  - **shorter than the interval**, or the key would still be held when the
 *    next tick arrives and that tick would be skipped everywhere.
 *
 * Half the interval is the simple point between them, and it is derived from
 * each job's own schedule rather than hand-picked 28 times — so a job added
 * later is covered without anyone choosing a number for it. The floor keeps
 * the 30-second pollers honest; the ceiling stops a weekly job holding a key
 * for days, which would turn one failed run into a skipped week.
 */
export const MIN_LOCK_TTL_MS = 10_000;
export const MAX_LOCK_TTL_MS = 60 * 60 * 1000;

export function lockTtlMs(intervalMs: number): number {
  return Math.min(
    MAX_LOCK_TTL_MS,
    Math.max(MIN_LOCK_TTL_MS, Math.floor(intervalMs / 2)),
  );
}

/**
 * Makes every registered cron run on one process per tick.
 *
 * ## Why it wraps the registry instead of each job site
 *
 * There are 28 `@Cron` jobs across 23 files. Decorating each one means the
 * 29th is a job someone forgets, and nothing fails when they do — the symptom
 * is a duplicate run in production, long after the commit.
 *
 * `SchedulerRegistry.getCronJobs()` returns every job Nest has registered, so
 * wrapping there covers all of them, including ones added later, with nothing
 * to remember. Same reasoning as the fail-closed specs in BE #251 and #252: a
 * net over the real list beats a hand-maintained copy of it.
 *
 * ## Why `onApplicationBootstrap`
 *
 * `ScheduleModule` registers jobs in its own `onApplicationBootstrap`. Nest
 * runs that phase in declaration order, and `AppModule` imports
 * `ScheduleModule` before this module's provider is constructed — but the
 * ordering guarantee is not something to rely on silently, so the wrap logs
 * what it found. A count of 0 in the logs means this ran too early and the
 * crons are unprotected, which is worth seeing rather than inferring.
 */
@Injectable()
export class CronLockBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(CronLockBootstrap.name);

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly lock: CronLockService,
  ) {}

  onApplicationBootstrap(): void {
    const jobs = this.registry.getCronJobs();
    let wrapped = 0;
    const skipped: string[] = [];

    for (const [name, job] of jobs) {
      // Through `unknown`: `_callbacks` is private on CronJob, so a direct
      // cast is refused (TS2352). Reaching past `private` is the whole point
      // here — see WrappableCronJob above for why that is sound.
      if (this.wrap(name, job as unknown as WrappableCronJob)) wrapped += 1;
      else skipped.push(name);
    }

    this.logger.log(
      `Cron single-run lock active on ${wrapped} of ${jobs.size} job(s)`,
    );

    // The count alone cannot answer "which ones?". Production logs 27
    // while `grep -c '@Cron(' src/` finds 28, and with only a number there
    // is no way to tell from a running system which declaration is missing
    // -- or whether a future one silently stops registering. Unnamed crons
    // appear here as the UUID Nest assigns them, which is itself the clue
    // that they were declared without a `name`.
    this.logger.debug(
      `Cron jobs registered: ${[...jobs.keys()].sort().join(', ')}`,
    );
    if (skipped.length > 0) {
      // Loud, because an unwrapped job is one that will double-fire once a
      // second process exists.
      this.logger.error(
        `Cron single-run lock NOT applied to: ${skipped.join(', ')}. These will run in every process once web and worker are split.`,
      );
    }
  }

  private wrap(name: string, job: WrappableCronJob): boolean {
    const callbacks = job._callbacks;
    if (!Array.isArray(callbacks) || callbacks.length === 0) return false;

    const interval = tickIntervalMs(job);
    if (interval === null) return false;
    const ttl = lockTtlMs(interval);

    const lock = this.lock;
    for (let i = 0; i < callbacks.length; i += 1) {
      const original = callbacks[i];
      callbacks[i] = async function wrappedTick(
        this: unknown,
        ...args: unknown[]
      ) {
        // Nothing is logged when the tick is not claimed. Losing the race is
        // the normal case on every process but one, so a line per job per tick
        // per process is log volume with no signal in it — the BE #128 shape.
        // The cron caller discards the return value either way.
        await lock.runOnce(name, ttl, () =>
          Promise.resolve(original.apply(this, args)),
        );
      };
    }
    return true;
  }
}
