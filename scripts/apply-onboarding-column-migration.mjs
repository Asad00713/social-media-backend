/**
 * One-off migration applier for `users.onboarding_completed_at`.
 *
 * The Drizzle journal on this project is out of sync with the Neon DB
 * (see scripts/apply-scheduled-inbox-migration.mjs for the back-story —
 * `drizzle-kit migrate` tries to re-run 0000 and errors with "users
 * already exists"). This script does the same additive work as
 * drizzle/migrations/0023_large_wallop.sql for the onboarding column
 * only, bypassing the broken journal.
 *
 * Safe to re-run — column add uses `IF NOT EXISTS`, backfill only stamps
 * rows where the value is still NULL.
 *
 * Run:  node scripts/apply-onboarding-column-migration.mjs
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
  // 1. Add the column (additive, non-destructive)
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "onboarding_completed_at" timestamp`,

  // 2. Backfill: any user who already owns a workspace is treated as onboarded.
  //    Stamps the time of their earliest owned workspace so analytics reflect
  //    when onboarding actually finished, not when this migration ran.
  `UPDATE "users" u
   SET "onboarding_completed_at" = w.first_created_at
   FROM (
     SELECT "owner_id", MIN("created_at") AS first_created_at
     FROM "workspace"
     GROUP BY "owner_id"
   ) w
   WHERE u."id" = w."owner_id" AND u."onboarding_completed_at" IS NULL`,
];

async function main() {
  console.log('🚀 Applying users.onboarding_completed_at migration...\n');
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

  // Sanity-check the backfill: zero users-with-workspaces should still be NULL.
  try {
    const orphans = await sql.query(
      `SELECT COUNT(*)::int AS n
       FROM "users" u
       WHERE u."onboarding_completed_at" IS NULL
         AND EXISTS (SELECT 1 FROM "workspace" w WHERE w."owner_id" = u."id")`,
    );
    const n = orphans[0]?.n ?? 0;
    if (n > 0) {
      console.warn(`\n⚠️  ${n} user(s) own a workspace but weren't backfilled — investigate.`);
    } else {
      console.log('\n  ✓ Backfill check passed: every workspace owner is stamped.');
    }
  } catch (err) {
    console.warn(`\n⚠️  Backfill sanity-check query failed (non-fatal): ${err.message}`);
  }

  console.log('\n✅ Done. users.onboarding_completed_at is ready.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
