-- =============================================================================
-- Calendar Sync — scheduled inbox messages (Task F)
--
-- Generalises `calendar_post_links` into `calendar_item_links`: one row still
-- links ONE Schedura item to ONE external calendar event, but the item is now
-- EITHER a scheduled post (`post_id`) OR a scheduled inbox message
-- (`message_id`) — an exclusive arc enforced by a CHECK.
--
-- ⚠ THIS TABLE HOLDS LIVE ROWS pointing at events that already exist in real
--   users' Google/Outlook calendars (tagged `schedura_post_id`). It is therefore
--   MIGRATED IN PLACE — RENAME + ALTER, never DROP/CREATE. Post events keep
--   their existing tag and their existing link rows; messages get a NEW parallel
--   tag (`schedura_message_id`).
--
-- Hand-written (not `db:generate`) to avoid bundling unrelated schema drift.
-- Mirrors src/drizzle/schema/calendar-sync.schema.ts. Safe to re-run.
--
-- id types: workspace_id / post_id / message_id are uuid (uuid pks); channel_id
-- is integer because social_media_channels.id is a bigserial (numeric) pk.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- ONE-LINERS (Railway web console mangles multi-line paste — paste these ONE AT
-- A TIME, in order; each is idempotent):
--
-- ALTER TABLE IF EXISTS "calendar_post_links" RENAME TO "calendar_item_links";
-- ALTER TABLE "calendar_item_links" ALTER COLUMN "post_id" DROP NOT NULL;
-- ALTER TABLE "calendar_item_links" ADD COLUMN IF NOT EXISTS "message_id" uuid;
-- DO $$ BEGIN ALTER TABLE "calendar_item_links" ADD CONSTRAINT "calendar_item_links_message_id_scheduled_inbox_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "scheduled_inbox_messages"("id") ON DELETE cascade; EXCEPTION WHEN duplicate_object THEN null; END $$;
-- DO $$ BEGIN ALTER TABLE "calendar_item_links" ADD CONSTRAINT "cil_exactly_one_owner" CHECK (num_nonnulls("post_id", "message_id") = 1); EXCEPTION WHEN duplicate_object THEN null; END $$;
-- ALTER TABLE "calendar_item_links" DROP CONSTRAINT IF EXISTS "cpl_channel_post_uq";
-- CREATE UNIQUE INDEX IF NOT EXISTS "cil_channel_post_uq" ON "calendar_item_links" ("channel_id", "post_id") WHERE "post_id" IS NOT NULL;
-- CREATE UNIQUE INDEX IF NOT EXISTS "cil_channel_message_uq" ON "calendar_item_links" ("channel_id", "message_id") WHERE "message_id" IS NOT NULL;
-- ALTER INDEX IF EXISTS "cpl_channel_event_ix" RENAME TO "cil_channel_event_ix";
-- CREATE INDEX IF NOT EXISTS "cil_channel_event_ix" ON "calendar_item_links" ("channel_id", "external_event_id");
-- -----------------------------------------------------------------------------


-- 1. Rename the table (in place — the rows and their FKs come along) ------------
-- `IF EXISTS` makes a re-run (table already renamed) a no-op instead of an error.
ALTER TABLE IF EXISTS "calendar_post_links" RENAME TO "calendar_item_links";

-- 2. post_id becomes optional (a message-owned row has none) --------------------
-- Idempotent by nature: dropping an already-absent NOT NULL is a no-op.
ALTER TABLE "calendar_item_links" ALTER COLUMN "post_id" DROP NOT NULL;

-- 3. The new message arc -------------------------------------------------------
ALTER TABLE "calendar_item_links" ADD COLUMN IF NOT EXISTS "message_id" uuid;

DO $$ BEGIN
  ALTER TABLE "calendar_item_links"
    ADD CONSTRAINT "calendar_item_links_message_id_scheduled_inbox_messages_id_fk"
    FOREIGN KEY ("message_id") REFERENCES "scheduled_inbox_messages"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 4. Exclusive arc: exactly one of (post_id, message_id) is set -----------------
-- Existing live rows all have post_id set + message_id NULL → they satisfy this,
-- so the constraint validates without touching them.
DO $$ BEGIN
  ALTER TABLE "calendar_item_links"
    ADD CONSTRAINT "cil_exactly_one_owner"
    CHECK (num_nonnulls("post_id", "message_id") = 1);
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 5. Swap the old (channel_id, post_id) unique for two PARTIAL uniques ----------
ALTER TABLE "calendar_item_links" DROP CONSTRAINT IF EXISTS "cpl_channel_post_uq";

CREATE UNIQUE INDEX IF NOT EXISTS "cil_channel_post_uq"
  ON "calendar_item_links" ("channel_id", "post_id")
  WHERE "post_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "cil_channel_message_uq"
  ON "calendar_item_links" ("channel_id", "message_id")
  WHERE "message_id" IS NOT NULL;

-- 6. Keep the (channel_id, external_event_id) lookup index ----------------------
-- A table RENAME does NOT rename its indexes, so rename it for consistency. The
-- CREATE below is the fresh-DB fallback (and a no-op after the rename).
ALTER INDEX IF EXISTS "cpl_channel_event_ix" RENAME TO "cil_channel_event_ix";

CREATE INDEX IF NOT EXISTS "cil_channel_event_ix"
  ON "calendar_item_links" ("channel_id", "external_event_id");

-- =============================================================================
-- Verification (optional):
--
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--     WHERE conrelid = 'calendar_item_links'::regclass;
--   SELECT indexname, indexdef FROM pg_indexes
--     WHERE tablename = 'calendar_item_links';
--   SELECT count(*) FROM calendar_item_links WHERE post_id IS NOT NULL; -- live post links survive
-- =============================================================================
