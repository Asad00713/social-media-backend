/**
 * One-off migration applier for `inbox_items.archived_at`.
 *
 * The Drizzle journal on this project is out of sync with the Neon DB
 * (see scripts/apply-onboarding-column-migration.mjs for the back-story —
 * `drizzle-kit migrate` re-runs 0000 and errors with "users already exists").
 * This script does the additive column add directly, bypassing the journal.
 *
 * Safe to re-run — `ADD COLUMN IF NOT EXISTS`.
 *
 * Run:  node scripts/apply-inbox-archived-at-migration.mjs
 */

import { config } from 'dotenv';
import { neon } from '@neondatabase/serverless';

config();

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL missing in .env');
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

const STATEMENTS = [
  // Soft-archive marker for inbox conversations/threads. Nullable; null = active.
  `ALTER TABLE "inbox_items" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone`,
];

async function main() {
  console.log('🚀 Applying inbox_items.archived_at migration...\n');
  for (let i = 0; i < STATEMENTS.length; i++) {
    const stmt = STATEMENTS[i];
    const preview = stmt.split('\n')[0].slice(0, 80);
    try {
      await sql.query(stmt);
      console.log(`  ✓ [${i + 1}/${STATEMENTS.length}] ${preview}…`);
    } catch (err) {
      console.error(`  ✗ [${i + 1}/${STATEMENTS.length}] ${preview}…`);
      console.error(`     ${err.message}`);
      process.exit(1);
    }
  }
  console.log('\n✅ Done. inbox_items.archived_at is ready.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
