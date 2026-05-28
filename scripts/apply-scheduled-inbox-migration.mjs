/**
 * One-off migration applier for scheduled_inbox_messages table.
 *
 * The Drizzle journal got out of sync with the Neon DB on this project
 * (drizzle-kit migrate tries to re-run already-applied migrations and
 * errors with "users already exists"). drizzle-kit push works but is
 * blocked in the sandboxed CLI.
 *
 * This script just runs the SQL from drizzle/migrations/0019_harsh_whistler.sql
 * directly against the database. Safe to re-run — every statement uses
 * `IF NOT EXISTS` semantics implicitly via try/catch.
 *
 * Run:  node scripts/apply-scheduled-inbox-migration.mjs
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
  // 1. Table
  `CREATE TABLE IF NOT EXISTS "scheduled_inbox_messages" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "workspace_id" uuid NOT NULL,
    "channel_id" integer NOT NULL,
    "type" varchar(10) NOT NULL,
    "thread_key" varchar(255) NOT NULL,
    "parent_item_id" uuid,
    "platform_post_id" varchar(255),
    "conversation_id" varchar(255),
    "target_label" text,
    "text" text NOT NULL,
    "scheduled_at" timestamp with time zone NOT NULL,
    "timezone" varchar(64),
    "status" varchar(20) DEFAULT 'pending' NOT NULL,
    "queue_job_id" varchar(255),
    "created_by_user_id" uuid,
    "sent_inbox_item_id" uuid,
    "error_message" text,
    "attempts" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  )`,

  // 2. Foreign keys (DO blocks make them idempotent)
  `DO $$ BEGIN
    ALTER TABLE "scheduled_inbox_messages"
      ADD CONSTRAINT "scheduled_inbox_messages_workspace_id_workspace_id_fk"
      FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade;
  EXCEPTION WHEN duplicate_object THEN null; END $$`,

  `DO $$ BEGIN
    ALTER TABLE "scheduled_inbox_messages"
      ADD CONSTRAINT "scheduled_inbox_messages_channel_id_social_media_channels_id_fk"
      FOREIGN KEY ("channel_id") REFERENCES "public"."social_media_channels"("id") ON DELETE cascade;
  EXCEPTION WHEN duplicate_object THEN null; END $$`,

  `DO $$ BEGIN
    ALTER TABLE "scheduled_inbox_messages"
      ADD CONSTRAINT "scheduled_inbox_messages_parent_item_id_inbox_items_id_fk"
      FOREIGN KEY ("parent_item_id") REFERENCES "public"."inbox_items"("id") ON DELETE set null;
  EXCEPTION WHEN duplicate_object THEN null; END $$`,

  `DO $$ BEGIN
    ALTER TABLE "scheduled_inbox_messages"
      ADD CONSTRAINT "scheduled_inbox_messages_created_by_user_id_users_id_fk"
      FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null;
  EXCEPTION WHEN duplicate_object THEN null; END $$`,

  `DO $$ BEGIN
    ALTER TABLE "scheduled_inbox_messages"
      ADD CONSTRAINT "scheduled_inbox_messages_sent_inbox_item_id_inbox_items_id_fk"
      FOREIGN KEY ("sent_inbox_item_id") REFERENCES "public"."inbox_items"("id") ON DELETE set null;
  EXCEPTION WHEN duplicate_object THEN null; END $$`,

  // 3. Indexes
  `CREATE INDEX IF NOT EXISTS "scheduled_inbox_workspace_status_idx" ON "scheduled_inbox_messages" USING btree ("workspace_id","status")`,
  `CREATE INDEX IF NOT EXISTS "scheduled_inbox_channel_status_idx" ON "scheduled_inbox_messages" USING btree ("channel_id","status")`,
  `CREATE INDEX IF NOT EXISTS "scheduled_inbox_scheduled_at_idx" ON "scheduled_inbox_messages" USING btree ("scheduled_at")`,
  `CREATE INDEX IF NOT EXISTS "scheduled_inbox_thread_key_idx" ON "scheduled_inbox_messages" USING btree ("workspace_id","thread_key","status")`,
];

async function main() {
  console.log('🚀 Applying scheduled_inbox_messages migration...\n');
  for (let i = 0; i < STATEMENTS.length; i++) {
    const stmt = STATEMENTS[i];
    const preview = stmt.split('\n')[0].slice(0, 80);
    try {
      // Neon's sql tag expects template literals — use .query for raw strings.
      await sql.query(stmt);
      console.log(`  ✓ [${i + 1}/${STATEMENTS.length}] ${preview}…`);
    } catch (err) {
      console.error(`  ✗ [${i + 1}/${STATEMENTS.length}] ${preview}…`);
      console.error(`     ${err.message}`);
      process.exit(1);
    }
  }
  console.log('\n✅ Done. scheduled_inbox_messages is ready.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
