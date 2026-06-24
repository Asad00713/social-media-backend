import { config } from 'dotenv';
config();

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { buildPoolConfig } from './pool-config';

/**
 * Shared Postgres connection pool (node-postgres / TCP).
 *
 * Migrated off Neon's HTTP serverless driver: Railway is standard TCP Postgres,
 * so a long-lived pool replaces the per-request HTTP fetch (and its transient-
 * retry wrapper — the pool reconnects natively). TLS policy lives in
 * `buildPoolConfig`: off on Railway's private network, verified on the public
 * proxy.
 */
const pool = new Pool(buildPoolConfig(process.env.DATABASE_URL!));

// A long-lived TCP pool emits 'error' on idle-client/network failures; without a
// listener Node escalates it to an uncaught exception and crashes the process.
pool.on('error', (err) => {
  console.error('[db] unexpected idle client error', err);
});

export const db = drizzle(pool, { schema });

export type DbType = typeof db;
