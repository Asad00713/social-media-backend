import type { PoolConfig } from 'pg';

/**
 * Build a node-postgres Pool config from a Postgres connection string.
 *
 * Railway runtime connects over the private network (host `*.railway.internal`)
 * with no TLS. Admin tasks from a local machine connect over the public proxy
 * (host `*.rlwy.net` / `*.railway.app`, or the URL carries `sslmode=`) and MUST
 * use VERIFIED TLS. We never set `rejectUnauthorized: false` (it permits MITM).
 * If Railway's proxy certificate is not in the system trust store, supply its CA
 * via the `DATABASE_CA_CERT` env var.
 */
export function buildPoolConfig(connectionString: string): PoolConfig {
  const needsSsl =
    /sslmode=(require|verify-ca|verify-full)/.test(connectionString) ||
    /\.rlwy\.net|\.railway\.app/.test(connectionString);

  const ca = process.env.DATABASE_CA_CERT;

  return {
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: needsSsl
      ? ca
        ? { ca, rejectUnauthorized: true }
        : { rejectUnauthorized: true }
      : false,
  };
}
