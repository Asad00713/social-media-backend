import { readFileSync } from 'fs';
import { join } from 'path';
import { config } from 'dotenv';
import { Client } from 'pg';
import { buildPoolConfig } from '../../drizzle/pool-config';
import { stripOuterTransaction } from '../../drizzle/migrate/runner';
import { decideTarget } from '../../drizzle/migrate/target-guard';

/**
 * Re-runs migration 0052 (inbox_conversations backfill) by hand. The owner runs
 * this once at the frontend switch to catch anything that drifted since the
 * migration ran at deploy. It is idempotent: triage state is never touched.
 */

const DEFAULT_SQL_PATH = join(
  process.cwd(),
  'drizzle',
  'migrations',
  '0052_inbox_conversations_backfill.sql',
);

export interface BackfillOptions {
  databaseUrl: string;
  confirmedProduction: boolean;
  sqlPath?: string;
  connect?: (url: string) => Promise<Client>;
}

async function defaultConnect(url: string): Promise<Client> {
  const { connectionString, ssl } = buildPoolConfig(url);
  const client = new Client({ connectionString, ssl });
  await client.connect();
  return client;
}

export async function runBackfill(
  opts: BackfillOptions,
): Promise<{ conversations: number }> {
  const target = decideTarget(opts.databaseUrl, opts.confirmedProduction);
  if (!target.allowed) {
    throw new Error(target.reason ?? 'target refused');
  }
  // A manual data command: unlike the boot migrator, the deploy-internal host
  // needs the flag too, so a Railway shell cannot hit production by accident.
  if (target.host.endsWith('.railway.internal') && !opts.confirmedProduction) {
    throw new Error(
      `refusing to run against "${target.host}" without --i-know-this-is-production ` +
        '(npm needs a `--` before it: npm run inbox:backfill -- --i-know-this-is-production).',
    );
  }

  // Read before connecting: a missing file should not open a connection.
  const sql = stripOuterTransaction(
    readFileSync(opts.sqlPath ?? DEFAULT_SQL_PATH, 'utf8'),
  );

  const client = await (opts.connect ?? defaultConnect)(opts.databaseUrl);
  try {
    await client.query('BEGIN');
    try {
      await client.query(sql);
      const counted = await client.query<{ n: string }>(
        'SELECT count(*) AS n FROM inbox_conversations',
      );
      await client.query('COMMIT');
      return { conversations: Number(counted.rows[0]?.n ?? 0) };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection may already be unusable; the original error wins.
      }
      throw error;
    }
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  config({ path: '.env' });
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[inbox:backfill] DATABASE_URL is not set; refusing to run.');
    process.exit(1);
  }
  try {
    const { conversations } = await runBackfill({
      databaseUrl: url,
      confirmedProduction: process.argv.includes('--i-know-this-is-production'),
    });
    console.log(
      `[inbox:backfill] done; inbox_conversations now holds ${conversations} row(s).`,
    );
  } catch (error) {
    console.error(
      `[inbox:backfill] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
