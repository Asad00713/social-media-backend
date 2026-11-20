import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';
import { APP_COMMIT, APP_VERSION } from '../common/app-version';

function makeDeps(opts: {
  dbOk?: boolean;
  redisOk?: boolean;
} = {}) {
  const { dbOk = true, redisOk = true } = opts;

  const pool = {
    query: jest.fn(() =>
      dbOk ? Promise.resolve({ rows: [{ ok: 1 }] }) : Promise.reject(new Error('no route to host')),
    ),
  };
  const redis = {
    ping: jest.fn(() =>
      redisOk ? Promise.resolve('PONG') : Promise.reject(new Error('connection refused')),
    ),
  };

  return { pool, redis };
}

describe('HealthController', () => {
  describe('GET /health/live', () => {
    it('reports ok', () => {
      const { pool, redis } = makeDeps();
      expect(new HealthController(pool as never, redis as never).live()).toEqual({
        status: 'ok',
      });
    });

    /**
     * The invariant that matters, and the reason live and ready are separate
     * routes at all. Liveness answers "is this process wedged?" — nothing
     * more. If it touched the database, a database outage would look like a
     * dead app and the platform would restart-loop a perfectly healthy
     * instance, turning a recoverable dependency blip into an outage of our
     * own making.
     *
     * Asserting the mocks were never called is the test; a status code alone
     * would pass even if the route quietly pinged everything.
     */
    it('checks no dependency at all', () => {
      const { pool, redis } = makeDeps({ dbOk: false, redisOk: false });

      const result = new HealthController(pool as never, redis as never).live();

      expect(result).toEqual({ status: 'ok' });
      expect(pool.query).not.toHaveBeenCalled();
      expect(redis.ping).not.toHaveBeenCalled();
    });
  });

  describe('GET /health/version', () => {
    it('reports the version and short commit, and nothing else', () => {
      const { pool, redis } = makeDeps({ dbOk: false, redisOk: false });

      const result = new HealthController(
        pool as never,
        redis as never,
      ).version();

      // Exact shape: adding a field here (env, host, region) is a decision,
      // not an accident - the route is unauthenticated.
      expect(result).toEqual({ version: APP_VERSION, commit: APP_COMMIT });
      expect(Object.keys(result).sort()).toEqual(['commit', 'version']);
      expect(result.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(result.commit).toMatch(/^([0-9a-f]{7}|dev)$/);
    });

    it('checks no dependency', () => {
      const { pool, redis } = makeDeps();
      new HealthController(pool as never, redis as never).version();
      expect(pool.query).not.toHaveBeenCalled();
      expect(redis.ping).not.toHaveBeenCalled();
    });
  });

  describe('GET /health/ready', () => {
    it('reports ok when both the database and Redis answer', async () => {
      const { pool, redis } = makeDeps();

      await expect(
        new HealthController(pool as never, redis as never).ready(),
      ).resolves.toEqual({
        status: 'ok',
        checks: { database: 'up', redis: 'up' },
      });
    });

    it('is unavailable when the database is unreachable', async () => {
      const { pool, redis } = makeDeps({ dbOk: false });

      await expect(
        new HealthController(pool as never, redis as never).ready(),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('is unavailable when Redis is unreachable', async () => {
      const { pool, redis } = makeDeps({ redisOk: false });

      await expect(
        new HealthController(pool as never, redis as never).ready(),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    /**
     * Readiness sheds traffic; it does not explain itself to the internet.
     * The body names which dependency is down — useful in a dashboard — but
     * the underlying error message, which can carry hostnames, ports and
     * credentials from a connection string, must not travel.
     */
    it('names the failing dependency without leaking the error', async () => {
      const { pool, redis } = makeDeps({ dbOk: false });

      const error = await new HealthController(pool as never, redis as never)
        .ready()
        .catch((e: ServiceUnavailableException) => e);

      const body = JSON.stringify((error as ServiceUnavailableException).getResponse());
      expect(body).toContain('down');
      expect(body).not.toContain('no route to host');
    });

    /**
     * Both checks run even when the first fails, so one request tells you the
     * whole story. Sequential checks would report the database and say
     * nothing about Redis.
     */
    it('checks both dependencies even when one is already failing', async () => {
      const { pool, redis } = makeDeps({ dbOk: false });

      await new HealthController(pool as never, redis as never).ready().catch(() => undefined);

      expect(pool.query).toHaveBeenCalledTimes(1);
      expect(redis.ping).toHaveBeenCalledTimes(1);
    });
  });
});
