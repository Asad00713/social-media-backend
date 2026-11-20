import {
  Controller,
  Get,
  Inject,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { DRIZZLE_POOL } from '../drizzle/drizzle.module';
import { REDIS_CLIENT } from '../channels/analytics/redis-client.provider';
import { APP_COMMIT, APP_VERSION } from '../common/app-version';

/** How long a dependency gets to answer before readiness calls it down. */
const PROBE_TIMEOUT_MS = 3_000;

type CheckState = 'up' | 'down';

/**
 * Infrastructure probes. Unauthenticated by design — the platform's health
 * checker has no credentials, and these expose nothing a caller could not
 * learn by watching whether the service answers at all.
 *
 * They pass the global WorkspaceSuspendedGuard untouched: it is a no-op for
 * routes with no `:workspaceId` param.
 */
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    @Inject(DRIZZLE_POOL) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Liveness: is this process still able to answer at all?
   *
   * Deliberately checks nothing else. A liveness probe that touched the
   * database would turn a database outage into a restart loop — the platform
   * would kill and recreate a perfectly healthy instance over and over while
   * the real problem sat elsewhere, and the restarts would make it worse.
   * Dependency health is `/health/ready`'s job, and the consequence there is
   * shedding traffic, not killing the process.
   */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Which build is this? Version from package.json, short git SHA from the
   * deploy platform. Nothing else — no environment, host, region or
   * dependency versions, which would help an attacker more than support.
   */
  @Get('version')
  version(): { version: string; commit: string } {
    return { version: APP_VERSION, commit: APP_COMMIT };
  }

  /**
   * Readiness: can this instance actually serve a request?
   *
   * 200 when Postgres and Redis both answer, 503 otherwise. A load balancer
   * uses this to route traffic away from an instance that cannot work,
   * without restarting it.
   */
  @Get('ready')
  async ready(): Promise<{
    status: 'ok';
    checks: Record<string, CheckState>;
  }> {
    // Both run regardless of the other's outcome, so one request reports the
    // whole picture rather than only the first thing to fail.
    const [database, redis] = await Promise.all([
      this.probe('database', () => this.pool.query('SELECT 1')),
      this.probe('redis', () => this.redis.ping()),
    ]);

    const checks: Record<string, CheckState> = { database, redis };

    if (database === 'down' || redis === 'down') {
      // The body names what is down; the underlying error does not travel.
      // Connection errors quote hosts, ports and sometimes credentials, and
      // this route answers anyone who asks.
      throw new ServiceUnavailableException({ status: 'error', checks });
    }

    return { status: 'ok', checks };
  }

  private async probe(
    name: string,
    run: () => Promise<unknown>,
  ): Promise<CheckState> {
    try {
      // A dependency that hangs must not hang the probe with it: without a
      // timeout the health checker waits on its own timeout instead, and an
      // unresponsive database reads as a slow instance rather than an
      // unready one.
      await Promise.race([
        run(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`${name} did not answer in ${PROBE_TIMEOUT_MS}ms`)),
            PROBE_TIMEOUT_MS,
          ).unref(),
        ),
      ]);
      return 'up';
    } catch (error) {
      this.logger.warn(`readiness: ${name} is down — ${(error as Error).message}`);
      return 'down';
    }
  }
}
