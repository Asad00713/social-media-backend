import { Inject, Injectable, Logger } from '@nestjs/common';

/** The one Redis command this needs. ioredis satisfies it. */
export interface CronLockRedis {
  set(
    key: string,
    value: string,
    mode: 'PX',
    ttlMs: number,
    flag: 'NX',
  ): Promise<'OK' | null>;
}

export const CRON_LOCK_REDIS = 'CRON_LOCK_REDIS';

/**
 * A hung Redis must not hold a cron open. ioredis queues commands offline by
 * default, so without a bound this could wait forever for a connection that is
 * not coming — the same failure measured in `metrics.module.ts`.
 */
export const ACQUIRE_TIMEOUT_MS = 2000;

const KEY_PREFIX = 'cron-lock:';

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`redis timeout after ${ms} ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * One run of a scheduled job across every process, for the tick it belongs to.
 *
 * ## The problem this exists for
 *
 * `ScheduleModule.forRoot()` is registered in `AppModule`, so **every process
 * that boots the app runs every cron**. Today there is one process and that is
 * fine. Splitting web from worker (Phase 2 #8) gives two, and then all 28 crons
 * fire twice on every tick.
 *
 * Twice is not harmless, and it is not uniformly harmful either — which is why
 * this is a shared lock rather than 28 separate fixes. Checked individually:
 *
 * | Shape | Double-fire does |
 * |---|---|
 * | deterministic `jobId` (reports, inbox later-wake, calendar sync) | nothing — BullMQ refuses the duplicate |
 * | conditional write (`stranded-post-sweeper`: `WHERE status = 'publishing'`) | nothing — the second write matches no row |
 * | **enqueue with no `jobId`** (`token-refresh.scheduler`) | **real damage** |
 * | nightly purge / retention | wasted work, double the load on one window |
 *
 * `token-refresh` is the one that must not happen: it enqueues a refresh per
 * channel with no `jobId`, and several platforms invalidate the old refresh
 * token when it is exchanged. Two concurrent refreshes for one channel can
 * therefore race into a token the platform no longer accepts — the user sees a
 * channel that disconnected itself overnight.
 *
 * ## Why a lock and not an env flag
 *
 * `RUN_CRONS=false` on the web service would also work, and it fails silently
 * when someone forgets it — including the person creating the second service
 * for the first time, who has no reason to know the variable exists. A missing
 * flag looks exactly like a working deployment until a channel drops.
 *
 * The lock needs no configuration, so there is nothing to forget. It also keeps
 * working for cases an env flag never covers: a rolling deploy where old and
 * new processes overlap, or two worker replicas.
 *
 * ## Fail-CLOSED, deliberately
 *
 * If Redis cannot be reached, the job is **skipped**, not run. That is the
 * opposite of `SendLockService`, which fails a send loudly, and the opposite of
 * most of this codebase's fail-open defaults — so it is worth being explicit:
 *
 * - every one of these jobs runs on a schedule, so a skipped tick is retried
 *   by the next one, minutes or hours later, at no cost to a user;
 * - running one anyway would mean running it in every process at once, which
 *   is the exact outcome this is here to prevent.
 *
 * A missed nightly purge is invisible. A double token refresh disconnects a
 * customer's channel. The asymmetry decides it.
 */
@Injectable()
export class CronLockService {
  private readonly logger = new Logger(CronLockService.name);

  constructor(@Inject(CRON_LOCK_REDIS) private readonly redis: CronLockRedis) {}

  /**
   * Runs `fn` on exactly one process for this tick, and returns whether it ran.
   *
   * `ttlMs` must be longer than the job's worst-case runtime and shorter than
   * its interval — see `CRON_LOCK_TTL_MS` in `cron-lock.decorator.ts` for how
   * that is derived from the schedule rather than guessed per job.
   *
   * The lock is NOT released when `fn` finishes. It expires on its own, which
   * is what makes this "once per tick" rather than "one at a time": releasing
   * early would let the other process pick up the same tick and run it again.
   */
  async runOnce<T>(
    name: string,
    ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<{ ran: boolean; result?: T }> {
    const acquired = await this.tryAcquire(name, ttlMs);
    if (!acquired) return { ran: false };

    const result = await fn();
    return { ran: true, result };
  }

  private async tryAcquire(name: string, ttlMs: number): Promise<boolean> {
    try {
      const ok = await withTimeout(
        this.redis.set(
          `${KEY_PREFIX}${name}`,
          String(process.pid),
          'PX',
          ttlMs,
          'NX',
        ),
        ACQUIRE_TIMEOUT_MS,
      );
      return ok === 'OK';
    } catch (error) {
      // Fail closed. See the class comment: a skipped tick costs one interval,
      // running in every process costs a disconnected channel.
      this.logger.warn(
        `Cron "${name}" skipped: could not reach Redis to claim the tick (${
          error instanceof Error ? error.message : 'unknown error'
        }). The next tick will try again.`,
      );
      return false;
    }
  }
}
