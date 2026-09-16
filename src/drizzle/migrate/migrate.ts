import { join } from 'node:path';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { buildPoolConfig } from '../pool-config';
import { decideTarget } from './target-guard';
import { planMigrations, readMigrations, type AppliedRow } from './runner';

config({ path: '.env' });

/**
 * Apply pending SQL migrations, once each, in filename order.
 *
 * Why this exists instead of `drizzle-kit migrate`: every migration from 0027
 * on is hand-written, so drizzle's `_journal.json` knows only 26 of the 37
 * files and its tracking table on production is EMPTY. `drizzle-kit migrate`
 * would try to replay 26 migrations from scratch against a live database.
 * This runner tracks files by name and checksum instead, and is the only
 * thing that should ever apply migrations.
 *
 * Each migration runs in its own transaction, with its applied-record written
 * inside that same transaction, so a crash can never leave a migration applied
 * but unrecorded (which would run it twice — `0030` drops a column).
 */

const MIGRATIONS_DIR = join(process.cwd(), 'drizzle', 'migrations');

/**
 * Advisory-lock key — any stable arbitrary number. Serialises concurrent
 * runners: Railway can start a new container while the old one is still
 * running, and without this the loser dies on a duplicate-key violation and
 * crash-loops until the platform retries it. With it, the loser waits, then
 * finds nothing pending.
 */
const LOCK_KEY = 4_027_150_930;

const TRACKING_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS applied_migrations (
    name        varchar(255) PRIMARY KEY,
    checksum    varchar(64)  NOT NULL,
    applied_at  timestamptz  NOT NULL DEFAULT now()
  )
`;

/** Postgres errors carry the fields that say WHICH statement failed. */
function describeError(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error);
  const e = error as Record<string, unknown>;
  const parts = [typeof e.message === 'string' ? e.message : String(error)];
  for (const key of ['code', 'detail', 'hint', 'where', 'position']) {
    const value = e[key];
    if (value !== undefined && value !== null && value !== '') {
      parts.push(`${key}: ${String(value)}`);
    }
  }
  return parts.join('\n  ');
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[migrate] DATABASE_URL is not set; refusing to run.');
    process.exit(1);
  }

  const target = decideTarget(
    url,
    process.argv.includes('--i-know-this-is-production'),
  );
  if (!target.allowed) {
    console.error(`[migrate] ${target.reason}`);
    process.exit(1);
  }

  // Read and validate every file BEFORE touching the database: an unsafe
  // migration should stop the boot without having opened a connection.
  const files = readMigrations(MIGRATIONS_DIR);
  const pool = new Pool(buildPoolConfig(url));

  try {
    await pool.query(TRACKING_TABLE_DDL);

    const lock = await pool.connect();
    try {
      // Held for the whole run, released when this connection is returned.
      await lock.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);

      const { rows } = await lock.query<AppliedRow>(
        'SELECT name, checksum FROM applied_migrations',
      );
      const { pending, drifted } = planMigrations(files, rows);

      if (drifted.length > 0) {
        console.error(
          '[migrate] REFUSING TO RUN. These already-applied migrations have ' +
            'changed on disk, so the database no longer matches them:\n' +
            drifted.map((n) => `  - ${n}`).join('\n') +
            '\nMigrations are immutable once applied. Add a new migration ' +
            'instead of editing one. If a file was changed by accident, ' +
            'restore it from git — see docs/migrations.md.',
        );
        process.exit(1);
      }

      if (pending.length === 0) {
        console.log(
          `[migrate] Up to date — ${rows.length} migration(s) already applied.`,
        );
        return;
      }

      console.log(`[migrate] ${pending.length} pending migration(s):`);
      for (const f of pending) console.log(`  - ${f.name}`);

      for (const file of pending) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(file.sql);
          // Written in the SAME transaction as the migration, so a crash can
          // never leave a migration applied but unrecorded — which would run
          // it a second time. 0030 drops a column; that is not survivable.
          await client.query(
            'INSERT INTO applied_migrations (name, checksum) VALUES ($1, $2)',
            [file.name, file.checksum],
          );
          await client.query('COMMIT');
          console.log(`[migrate] applied ${file.name}`);
        } catch (error) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // The connection may already be unusable; the original error wins.
          }
          console.error(`[migrate] FAILED on ${file.name}`);
          throw error;
        } finally {
          client.release();
        }
      }

      console.log(`[migrate] done — applied ${pending.length} migration(s).`);
    } finally {
      lock.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('[migrate]', describeError(error));
  process.exit(1);
});
