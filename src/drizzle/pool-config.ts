import type { PoolConfig } from 'pg';

/**
 * Build a node-postgres Pool config from a Postgres connection string.
 *
 * Railway runtime connects over the private network (host `*.railway.internal`)
 * with no TLS. Admin tasks from a local machine connect over the public proxy
 * (host `*.proxy.rlwy.net`, or the URL carries `sslmode=`) and MUST use VERIFIED
 * TLS. We never set `rejectUnauthorized: false` (it permits MITM). If Railway's
 * proxy certificate is not in the system trust store, supply its CA (the full
 * chain) via the `DATABASE_CA_CERT` env var.
 *
 * When a CA is pinned we run in `verify-ca` mode: the chain is still fully
 * verified against that pinned CA, but the hostname check is skipped. Railway's
 * managed-Postgres certificate is issued for the database instance, not for the
 * public proxy host, so a hostname match would always fail even though we are
 * genuinely talking to our pinned server. Skipping only the hostname (not the
 * chain) keeps MITM protection intact.
 */
export function buildPoolConfig(connectionString: string): PoolConfig {
  const needsSsl =
    /sslmode=(require|verify-ca|verify-full)/.test(connectionString) ||
    /\.rlwy\.net/.test(connectionString);

  const ca = process.env.DATABASE_CA_CERT;

  return {
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: needsSsl
      ? ca
        ? {
            ca,
            rejectUnauthorized: true,
            // verify-ca: chain verified against the pinned CA, hostname skipped.
            checkServerIdentity: () => undefined,
          }
        : { rejectUnauthorized: true }
      : false,
  };
}
