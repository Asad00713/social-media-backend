import { join } from 'node:path';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { buildPoolConfig } from '../pool-config';
import { readMigrations } from './runner';

config({ path: '.env' });

/**
 * Record migrations as already applied WITHOUT running them.
 *
 * This exists for exactly one situation: a database whose schema was brought
 * up to date by hand, before the runner existed. Production is in that state —
 * 0024 and 0027 through 0035 were applied manually via the Railway console,
 * and drizzle's own tracking table is empty and unusable.
 *
 * Without this step the runner would see those files as pending and re-run
 * them. `0030` drops a column and `0032` creates tables; re-running is not
 * survivable. So: baseline first, then the runner has an honest starting point.
 *
 *   npm run db:baseline -- --upto 0035_error_logs.sql
 *
 * `--upto` is required. Defaulting to "everything" would make the dangerous
 * case the easy one to reach by accident.
 */

const MIGRATIONS_DIR = join(process.cwd(), 'drizzle', 'migrations');

function parseUpto(argv: string[]): string | null {
  const i = argv.indexOf('--upto');
  if (i === -1 || !argv[i + 1]) return null;
  return argv[i + 1];
}

const TRACKING_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS applied_migrations (
    name        varchar(255) PRIMARY KEY,
    checksum    varchar(64)  NOT NULL,
    applied_at  timestamptz  NOT NULL DEFAULT now()
  )
`;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[baseline] DATABASE_URL is not set; refusing to run.');
    process.exit(1);
  }

  const upto = parseUpto(process.argv.slice(2));
  if (!upto) {
    console.error(
      '[baseline] --upto <filename> is required, e.g.\n' +
        '  npm run db:baseline -- --upto 0035_error_logs.sql',
    );
    process.exit(1);
  }

  const files = readMigrations(MIGRATIONS_DIR);
  const cut = files.findIndex((f) => f.name === upto);
  if (cut === -1) {
    console.error(
      `[baseline] no migration named "${upto}". Available (last 5):\n` +
        files
          .slice(-5)
          .map((f) => `  - ${f.name}`)
          .join('\n'),
    );
    process.exit(1);
  }

  const toMark = files.slice(0, cut + 1);
  const pool = new Pool(buildPoolConfig(url));

  try {
    await pool.query(TRACKING_TABLE_DDL);

    // ON CONFLICT DO NOTHING: baselining twice is a no-op, and it must never
    // overwrite a checksum recorded by a real run.
    let marked = 0;
    for (const file of toMark) {
      const res = await pool.query(
        `INSERT INTO applied_migrations (name, checksum)
         VALUES ($1, $2)
         ON CONFLICT (name) DO NOTHING`,
        [file.name, file.checksum],
      );
      marked += res.rowCount ?? 0;
    }

    console.log(
      `[baseline] marked ${marked} migration(s) as applied without running ` +
        `them (through ${upto}). ${toMark.length - marked} were already recorded.`,
    );
    console.log('[baseline] run `npm run db:migrate:sql` to apply the rest.');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('[baseline]', error instanceof Error ? error.message : error);
  process.exit(1);
});
