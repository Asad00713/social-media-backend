-- 0057 - Library sample content: an is_sample flag on every Library kind.
--
-- WHY
-- Every NEW workspace gets a "Getting started" folder per tab with sample
-- images, templates, snippets and a link (LibrarySamplesService, seeded after
-- the workspace is created). The UI shows a "Sample" badge on them, so the
-- five Library tables get `is_sample boolean NOT NULL DEFAULT false`:
-- media_items, media_templates, text_snippets, saved_links, media_categories.
-- Existing rows are real content and stay false; nothing is backfilled and no
-- existing workspace is seeded.
--
-- Samples are made by no one (createdBy null), but media_items.uploaded_by_id
-- and created_by_id on templates, snippets and links are NOT NULL. This drops
-- NOT NULL on those four columns and adds a CHECK per table so that only a
-- sample row may have no creator: every real row still must name one, as
-- before. The foreign keys (ON DELETE CASCADE) are unchanged.
-- (media_categories.created_by_id is already nullable, since 0056.)
--
-- Sample images are shared files served by the API itself
-- (/static/library-samples/v1/...): every workspace's sample rows point at
-- the same URL. The app never counts a sample's bytes as storage and never
-- deletes a sample's file; is_sample is how it tells.
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY. Idempotent: ADD COLUMN IF NOT EXISTS, DROP NOT NULL (a no-op
-- on a nullable column), and each CHECK inside a duplicate_object guard.
-- ADD COLUMN with a constant DEFAULT is metadata only in Postgres 11+ (no
-- table rewrite). DROP NOT NULL is metadata only. Each CHECK scans its table
-- once to validate (every existing row has a creator, so it passes). Nothing
-- is dropped, no row is written. The running backend selects named columns
-- and always writes a creator, so it works unchanged before and after this
-- file: safe to apply on start.
--
-- LOCKS AND COST
-- `SET LOCAL lock_timeout = '10s'` comes first (I4). The ALTERs take ACCESS
-- EXCLUSIVE on the five tables until COMMIT; without the timeout they would
-- queue behind any open transaction on the still-running old instance and
-- every Library read would queue behind them. With it a blocked deploy fails
-- fast and rolls back; retry the deploy. The cost is the four CHECK
-- validations: one sequential scan each of media_items, media_templates,
-- text_snippets and saved_links. Check media_items' row count first if it
-- has grown by orders of magnitude.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   DELETE FROM media_items WHERE is_sample;       -- and the same for the
--   DELETE FROM media_templates WHERE is_sample;   -- other four tables, since
--   DELETE FROM text_snippets WHERE is_sample;     -- sample rows have no
--   DELETE FROM saved_links WHERE is_sample;       -- creator and would block
--   DELETE FROM media_categories WHERE is_sample;  -- SET NOT NULL
--   ALTER TABLE media_items DROP CONSTRAINT IF EXISTS media_items_creator_chk;
--   ALTER TABLE media_templates DROP CONSTRAINT IF EXISTS media_templates_creator_chk;
--   ALTER TABLE text_snippets DROP CONSTRAINT IF EXISTS text_snippets_creator_chk;
--   ALTER TABLE saved_links DROP CONSTRAINT IF EXISTS saved_links_creator_chk;
--   ALTER TABLE media_items ALTER COLUMN uploaded_by_id SET NOT NULL;
--   ALTER TABLE media_templates ALTER COLUMN created_by_id SET NOT NULL;
--   ALTER TABLE text_snippets ALTER COLUMN created_by_id SET NOT NULL;
--   ALTER TABLE saved_links ALTER COLUMN created_by_id SET NOT NULL;
--   ALTER TABLE <each of the five> DROP COLUMN IF EXISTS is_sample;
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

-- 1. The flag -----------------------------------------------------------------

ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "is_sample" boolean NOT NULL DEFAULT false;
ALTER TABLE "media_templates" ADD COLUMN IF NOT EXISTS "is_sample" boolean NOT NULL DEFAULT false;
ALTER TABLE "text_snippets" ADD COLUMN IF NOT EXISTS "is_sample" boolean NOT NULL DEFAULT false;
ALTER TABLE "saved_links" ADD COLUMN IF NOT EXISTS "is_sample" boolean NOT NULL DEFAULT false;
ALTER TABLE "media_categories" ADD COLUMN IF NOT EXISTS "is_sample" boolean NOT NULL DEFAULT false;

-- 2. Samples have no creator; real rows still must -------------------------

ALTER TABLE "media_items" ALTER COLUMN "uploaded_by_id" DROP NOT NULL;
ALTER TABLE "media_templates" ALTER COLUMN "created_by_id" DROP NOT NULL;
ALTER TABLE "text_snippets" ALTER COLUMN "created_by_id" DROP NOT NULL;
ALTER TABLE "saved_links" ALTER COLUMN "created_by_id" DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE "media_items" ADD CONSTRAINT "media_items_creator_chk"
    CHECK ("is_sample" OR "uploaded_by_id" IS NOT NULL);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "media_templates" ADD CONSTRAINT "media_templates_creator_chk"
    CHECK ("is_sample" OR "created_by_id" IS NOT NULL);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "text_snippets" ADD CONSTRAINT "text_snippets_creator_chk"
    CHECK ("is_sample" OR "created_by_id" IS NOT NULL);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "saved_links" ADD CONSTRAINT "saved_links_creator_chk"
    CHECK ("is_sample" OR "created_by_id" IS NOT NULL);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
