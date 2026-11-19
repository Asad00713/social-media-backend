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
 *
 * ## Pool size
 *
 * `max` is the per-pool ceiling, and the process holds more than one pool's
 * worth only if more than one pool exists — see `drizzle.module.ts`, which
 * deliberately reuses the single pool from `db.ts` rather than opening a
 * second. The real ceiling is Postgres' `max_connections`, which on Railway's
 * managed instance is not visible from here, so the default stays at the
 * conservative 10 this app shipped with and `DB_POOL_MAX` raises it once that
 * number is known. A value that exceeds what Postgres allows does not fail at
 * boot — it fails later, under load, as `too many clients already`.
 */

/** Default per-pool connection ceiling, used when `DB_POOL_MAX` is unset. */
export const DEFAULT_POOL_MAX = 10;

/**
 * Reads `DB_POOL_MAX`, falling back to {@link DEFAULT_POOL_MAX}.
 *
 * A non-numeric, zero or negative value is ignored rather than honoured: a
 * typo in a Railway variable would otherwise produce a pool of 0 (every query
 * waits forever) or NaN (node-postgres treats it as unbounded), and both are
 * worse than the default.
 */
function resolvePoolMax(): number {
  const raw = process.env.DB_POOL_MAX;
  if (!raw) return DEFAULT_POOL_MAX;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_POOL_MAX;

  return parsed;
}
export function buildPoolConfig(connectionString: string): PoolConfig {
  const needsSsl =
    /sslmode=(require|verify-ca|verify-full)/.test(connectionString) ||
    /\.rlwy\.net/.test(connectionString);

  const ca = process.env.DATABASE_CA_CERT;

  return {
    connectionString,
    max: resolvePoolMax(),
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
