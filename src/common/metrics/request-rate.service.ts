import { Inject, Injectable, Logger } from '@nestjs/common';

/**
 * Only the commands this service uses, so a test can supply a fake and so it
 * is obvious at a glance that nothing here does an unbounded read.
 * Matches the shape `QuotaTrackerService` established.
 */
export interface RequestRateRedis {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<number | string>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  keys(pattern: string): Promise<string[]>;
  mget(...keys: string[]): Promise<Array<string | null>>;
  del(...keys: string[]): Promise<number>;
}

export const REQUEST_RATE_REDIS = 'REQUEST_RATE_REDIS';

/**
 * How long a minute's counters live. Long enough to be read by the admin
 * endpoint on any reasonable schedule, short enough that the key space can
 * never grow without bound. Every key this service writes carries a TTL —
 * there is no sweeper to forget to run.
 */
export const RATE_WINDOW_TTL_SECONDS = 36 * 60 * 60;

/** Buckets a per-minute count falls into, for a distribution without storing
 * every sample. Open-ended at the top. */
export const RATE_BUCKETS = [
  1, 2, 5, 10, 20, 40, 80, 160, 320, 640, 1280,
] as const;

export interface RateSnapshot {
  /** Minute keys seen, newest first. */
  samples: number;
  /** Counts per bucket ceiling, e.g. `{ '10': 412 }` = 412 workspace-minutes
   *  where that workspace made 6..10 requests. */
  histogram: Record<string, number>;
  p50: number;
  p90: number;
  p99: number;
  max: number;
}

/**
 * Counts requests per workspace per minute, and nothing else.
 *
 * ## Why this exists before any global limit
 *
 * `app.module.ts` registers `ThrottlerModule` with no app guard, and its
 * comment says why: the platform "has not been measured for it". Choosing a
 * global limit without that measurement has two failure modes and both are
 * bad — too high and it protects nothing, too low and a customer is thrown out
 * of a dashboard that happens to issue thirty calls on load.
 *
 * So this phase measures and refuses nothing. It answers one question: what
 * does a real workspace's busiest minute look like? The limit comes afterwards,
 * from the answer.
 *
 * ## What it deliberately does NOT do
 *
 * **No database table.** A row per request would be ~130k rows a day, which is
 * exactly how `error_logs` reached 738MB / 2.17M rows in 17 days (BE #128). The
 * lesson from that incident is the design here: Redis only, and every key
 * expires itself.
 *
 * **No per-request latency, status or payload.** Those belong in Sentry, which
 * is already wired. This is a counter, not a tracing system.
 *
 * **No unbounded key space.** Keys are `rate:<workspace>:<minute>` and
 * `rate:route:<route pattern>:<minute>`. The route is the Express PATTERN
 * (`/posts/:id`), measured — `req.route.path` yields the pattern, not the
 * filled-in value — so 774 routes produce at most 774 keys a minute rather
 * than one per post id.
 */
@Injectable()
export class RequestRateService {
  private readonly logger = new Logger(RequestRateService.name);

  /** Logged at most once, so a Redis outage cannot itself become log spam —
   *  the second lesson of BE #128. */
  private warnedThisProcess = false;

  constructor(
    @Inject(REQUEST_RATE_REDIS) private readonly redis: RequestRateRedis,
  ) {}

  /**
   * `2026-11-19T1307` — UTC, minute resolution, and deliberately **without
   * the colon** ISO-8601 puts in the time.
   *
   * The colon is the key separator here, and a route pattern is full of them
   * (`/w/:workspaceId/posts/:id`). With a colon in the minute too, nothing can
   * tell the two apart: splitting a key on its last colon then cuts the minute
   * in half and leaves `…/posts/:id:2026-11-19T13` as the route name. Removing
   * it from the one field that does not need it makes the last colon
   * unambiguous.
   */
  static minuteKey(at: Date = new Date()): string {
    return at.toISOString().slice(0, 16).replace(':', '');
  }

  /**
   * Record one request. Never throws and never delays the response: a metrics
   * write must not be able to fail a customer's request, so the caller fires
   * this without awaiting and every error is swallowed here.
   */
  record(scope: { workspaceId?: string; route: string }, at?: Date): void {
    const minute = RequestRateService.minuteKey(at);
    const keys = [`rate:route:${scope.route}:${minute}`];
    if (scope.workspaceId) keys.push(`rate:ws:${scope.workspaceId}:${minute}`);

    void Promise.all(
      keys.map(async (key) => {
        const count = await this.redis.incr(key);
        // Only the first write of a minute needs to set the TTL. Re-setting it
        // on every request would be an extra round trip per request for no
        // change in behaviour.
        if (count === 1) {
          await this.redis.expire(key, RATE_WINDOW_TTL_SECONDS);
          await this.redis.zadd(`rate:minutes`, Date.now(), minute);
        }
      }),
    ).catch((error: unknown) => {
      if (this.warnedThisProcess) return;
      this.warnedThisProcess = true;
      this.logger.warn(
        `Request-rate metrics unavailable (counting only, no requests affected): ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    });
  }

  /**
   * The distribution of per-workspace per-minute counts over the window.
   *
   * This is the number a global limit has to be chosen against: if the 99th
   * percentile workspace-minute is 40 requests, a limit of 120 affects
   * approximately nobody, and one of 30 throws out one customer-minute in a
   * hundred.
   */
  async workspaceSnapshot(): Promise<RateSnapshot> {
    return this.snapshotOf('rate:ws:*');
  }

  /** The same distribution per route pattern, to find which single endpoint a
   *  client hammers hardest. */
  async routeSnapshot(): Promise<RateSnapshot> {
    return this.snapshotOf('rate:route:*');
  }

  /**
   * The busiest route patterns in the window, so a per-route limit can be
   * aimed at the endpoint that needs one rather than applied to all 774.
   */
  async busiestRoutes(
    limit = 20,
  ): Promise<Array<{ route: string; peakPerMinute: number; total: number }>> {
    const keys = await this.safeKeys('rate:route:*');
    if (keys.length === 0) return [];

    const values = await this.redis.mget(...keys);
    const byRoute = new Map<string, { peak: number; total: number }>();

    keys.forEach((key, i) => {
      // `rate:route:<pattern>:<minute>` — the pattern itself can contain
      // colons, so take everything between the prefix and the LAST colon.
      const body = key.slice('rate:route:'.length);
      const route = body.slice(0, body.lastIndexOf(':'));
      const count = Number(values[i] ?? 0);
      if (!route || !Number.isFinite(count)) return;
      const seen = byRoute.get(route) ?? { peak: 0, total: 0 };
      byRoute.set(route, {
        peak: Math.max(seen.peak, count),
        total: seen.total + count,
      });
    });

    return [...byRoute.entries()]
      .map(([route, v]) => ({
        route,
        peakPerMinute: v.peak,
        total: v.total,
      }))
      .sort((a, b) => b.peakPerMinute - a.peakPerMinute)
      .slice(0, limit);
  }

  private async snapshotOf(pattern: string): Promise<RateSnapshot> {
    const keys = await this.safeKeys(pattern);
    if (keys.length === 0) {
      return { samples: 0, histogram: {}, p50: 0, p90: 0, p99: 0, max: 0 };
    }

    const values = await this.redis.mget(...keys);
    const counts = values
      .map((v) => Number(v ?? 0))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);

    if (counts.length === 0) {
      return { samples: 0, histogram: {}, p50: 0, p90: 0, p99: 0, max: 0 };
    }

    const histogram: Record<string, number> = {};
    for (const count of counts) {
      const bucket =
        RATE_BUCKETS.find((b) => count <= b) ??
        RATE_BUCKETS[RATE_BUCKETS.length - 1];
      const label = count > bucket ? `${bucket}+` : String(bucket);
      histogram[label] = (histogram[label] ?? 0) + 1;
    }

    return {
      samples: counts.length,
      histogram,
      p50: percentile(counts, 50),
      p90: percentile(counts, 90),
      p99: percentile(counts, 99),
      max: counts[counts.length - 1],
    };
  }

  /**
   * `KEYS` is O(n) over the keyspace and is normally the wrong tool. It is
   * acceptable here for one reason that has to stay true: the key space is
   * bounded by (workspaces + 774 routes) x minutes in a 36-hour TTL, and this
   * runs only when an admin opens the report — never on a request path.
   */
  private async safeKeys(pattern: string): Promise<string[]> {
    try {
      return await this.redis.keys(pattern);
    } catch (error) {
      this.logger.warn(
        `Could not read request-rate keys: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return [];
    }
  }
}

/** Nearest-rank percentile of an ASCENDING array. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}
