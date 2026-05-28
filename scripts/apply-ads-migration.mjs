/**
 * One-off migration applier for Meta Ads Phase 1 tables.
 *
 * The Drizzle journal got out of sync with the Neon DB on this project
 * (drizzle-kit migrate tries to re-run already-applied migrations and
 * errors with "users already exists"). This script runs the SQL from
 * drizzle/migrations/0020_absurd_ken_ellis.sql directly against Neon.
 * Safe to re-run — every statement uses IF NOT EXISTS / DO $$ EXCEPTION blocks.
 *
 * Run:  node scripts/apply-ads-migration.mjs
 */

import { config } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

config();

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL missing in .env');
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationPath = join(__dirname, '../drizzle/migrations/0020_absurd_ken_ellis.sql');

const raw = readFileSync(migrationPath, 'utf8');

// Split on the drizzle statement breakpoint marker
const rawStatements = raw.split('--> statement-breakpoint');

// Build final statements array: wrap CREATE TYPE and ALTER TABLE / CREATE INDEX
// with idempotent DO $$ blocks; wrap CREATE TABLE with IF NOT EXISTS.
const statements = rawStatements
  .map((s) => s.trim())
  .filter(Boolean)
  .map((stmt) => {
    // CREATE TYPE → wrap in DO $$ ... EXCEPTION WHEN duplicate_object
    if (/^CREATE TYPE/i.test(stmt)) {
      // Strip any trailing semicolon before wrapping, then add one inside the block
      const inner = stmt.replace(/;$/, '');
      return `DO $$ BEGIN\n  ${inner};\nEXCEPTION WHEN duplicate_object THEN null; END $$`;
    }
    // CREATE TABLE → add IF NOT EXISTS
    if (/^CREATE TABLE "/.test(stmt)) {
      return stmt.replace(/^CREATE TABLE "/, 'CREATE TABLE IF NOT EXISTS "');
    }
    // ALTER TABLE ... ADD CONSTRAINT → wrap in DO $$ ... EXCEPTION WHEN duplicate_object
    if (/^ALTER TABLE.*ADD CONSTRAINT/i.test(stmt)) {
      const inner = stmt.replace(/;$/, '');
      return `DO $$ BEGIN\n  ${inner};\nEXCEPTION WHEN duplicate_object THEN null; END $$`;
    }
    // CREATE INDEX / CREATE UNIQUE INDEX → add IF NOT EXISTS
    if (/^CREATE (UNIQUE )?INDEX "/.test(stmt)) {
      return stmt.replace(/^CREATE (UNIQUE )?INDEX "/, (m, unique) =>
        `CREATE ${unique || ''}INDEX IF NOT EXISTS "`,
      );
    }
    return stmt;
  });

async function main() {
  console.log(`🚀 Applying Meta Ads Phase 1 migration (${statements.length} statements)...\n`);
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    const preview = stmt.replace(/\n/g, ' ').slice(0, 90);
    try {
      await sql.query(stmt);
      console.log(`  ✓ [${i + 1}/${statements.length}] ${preview}…`);
    } catch (err) {
      // Swallow "already exists" class errors (42P07 = duplicate_table, 42710 = duplicate_object)
      if (err.code === '42P07' || err.code === '42710' || err.message?.includes('already exists')) {
        console.log(`  ~ [${i + 1}/${statements.length}] already exists, skipping — ${preview}…`);
      } else {
        console.error(`  ✗ [${i + 1}/${statements.length}] FAILED — ${preview}`);
        console.error(`     Code: ${err.code}  Message: ${err.message}`);
        process.exit(1);
      }
    }
  }
  console.log('\n✅ Done. All Meta Ads Phase 1 tables are ready.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
