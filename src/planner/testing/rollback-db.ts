import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client, type Pool, type PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../drizzle/schema';
// Type-only (erased): the app's own db type, so services accept the harness db.
import type { DbType as AppDbType } from '../../drizzle/db';

export type DbType = AppDbType;

/** `describe` only when PLANNER_DB_TESTS=1, so CI never needs a database. */
export const describeDb: typeof describe =
  process.env.PLANNER_DB_TESTS === '1' ? describe : describe.skip;

// Each rollback setup replays every migration on one connection (8-17s), which
// overruns jest's 5s default. Run DB specs with `--runInBand`: parallel suites
// replaying migrations against one database deadlock on catalog locks.
if (process.env.PLANNER_DB_TESTS === '1') jest.setTimeout(30_000);

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const MIGRATIONS_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  'drizzle',
  'migrations',
);

export function assertLocalDatabase(
  url: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!url) throw new Error('DATABASE_URL is not set');
  const parsed = new URL(url);
  const host = parsed.hostname;
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Refusing to run DB specs against non-local host "${host}"`,
    );
  }
  // libpq lets a query parameter or PGHOST override the URL host.
  for (const key of ['host', 'hostaddr']) {
    if (parsed.searchParams.has(key)) {
      throw new Error(
        `Refusing to run DB specs: DATABASE_URL carries a "${key}" override`,
      );
    }
  }
  if (env.PGHOST && !LOCAL_HOSTS.has(env.PGHOST)) {
    throw new Error(
      `Refusing to run DB specs: PGHOST is "${env.PGHOST}", not local`,
    );
  }
  if (env.PGHOSTADDR && env.PGHOSTADDR !== '127.0.0.1') {
    throw new Error(
      `Refusing to run DB specs: PGHOSTADDR is "${env.PGHOSTADDR}", not local`,
    );
  }
  return url;
}

/** Thrown to unwind the harness transaction while carrying fn's result. */
class RollbackSignal<T> extends Error {
  constructor(readonly value: T) {
    super('rollback');
  }
}

/**
 * Runs `fn` inside a transaction that is ALWAYS rolled back. The named
 * migration files are applied first, twice, to prove they are idempotent.
 * The session time zone is Asia/Karachi so UTC-vs-local bugs surface.
 *
 * `fn` receives drizzle's transaction object, not the root instance: on a
 * non-Pool client drizzle's own `db.transaction()` would issue `begin` /
 * `commit` and COMMIT the harness transaction. On a transaction object a
 * nested `transaction()` uses savepoints, so the final rollback still wins.
 * `client` is the very connection the transaction runs on.
 */
export async function withRollbackDb<T>(
  migrations: string[],
  fn: (db: DbType, client: PoolClient) => Promise<T>,
): Promise<T> {
  const url = assertLocalDatabase(process.env.DATABASE_URL);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const poolClient = client as unknown as PoolClient;
    // The app's db is built on a Pool and carries `$client: Pool`. A single
    // Client is the narrowest stand-in: it exposes the same `query` surface
    // drizzle uses, and `$client` is never read by services.
    const root = drizzle(poolClient as unknown as Pool, { schema });
    await root.transaction(async (tx) => {
      await client.query(`SET LOCAL TIME ZONE 'Asia/Karachi'`);
      for (const file of migrations) {
        const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
        await client.query(sql);
        await client.query(sql);
      }
      const result = await fn(tx as unknown as DbType, poolClient);
      throw new RollbackSignal(result);
    });
    throw new Error('withRollbackDb: transaction ended without a rollback');
  } catch (err) {
    if (err instanceof RollbackSignal) return err.value as T;
    throw err;
  } finally {
    await client.end();
  }
}
