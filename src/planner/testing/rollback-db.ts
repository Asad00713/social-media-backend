import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client, type PoolClient } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../drizzle/schema';

export type DbType = NodePgDatabase<typeof schema>;

/** `describe` only when PLANNER_DB_TESTS=1, so CI never needs a database. */
export const describeDb: typeof describe =
  process.env.PLANNER_DB_TESTS === '1' ? describe : describe.skip;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const MIGRATIONS_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  'drizzle',
  'migrations',
);

function assertLocalDatabase(url: string | undefined): string {
  if (!url) throw new Error('DATABASE_URL is not set');
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Refusing to run DB specs against non-local host "${host}"`,
    );
  }
  return url;
}

/**
 * Runs `fn` inside a transaction that is ALWAYS rolled back. The named
 * migration files are applied first, twice, to prove they are idempotent.
 * The session time zone is Asia/Karachi so UTC-vs-local bugs surface.
 */
export async function withRollbackDb<T>(
  migrations: string[],
  fn: (db: DbType, client: PoolClient) => Promise<T>,
): Promise<T> {
  const url = assertLocalDatabase(process.env.DATABASE_URL);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL TIME ZONE 'Asia/Karachi'`);
    for (const file of migrations) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query(sql);
      await client.query(sql);
    }
    const poolClient = client as unknown as PoolClient;
    const db = drizzle(poolClient, { schema });
    return await fn(db, poolClient);
  } finally {
    try {
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  }
}
