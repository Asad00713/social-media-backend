-- 0059 - Workspace brand kit: colours, a default logo and adjust presets.
--
-- WHY
-- The composer's photo editor draws three things that belong to the
-- workspace rather than to one post: the Text tool's "Colour · from your
-- brand kit" swatches, the Watermark tool's "Workspace default" logo and the
-- Adjust tool's "Team presets". One row per workspace holds all three:
--   colors          jsonb array of '#rrggbb' strings (validated by the API)
--   logo_media_id   a Library image (media_items.id). The Library already
--                   stores the file; SET NULL if that item is hard-deleted
--   adjust_presets  jsonb array of { id, name, values } (validated by the API)
--   updated_by_id   who changed it last; SET NULL when that user is deleted
-- A missing row means an empty kit; nothing is backfilled.
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY. New table only: no existing table is altered, no row is
-- read, written or dropped. The foreign keys take a SHARE ROW EXCLUSIVE lock
-- on workspace, media_items and users for the length of this transaction
-- (validated against an empty table, so instant); `lock_timeout` bounds the
-- wait behind the still-running old instance (I4). Idempotent: CREATE TABLE
-- IF NOT EXISTS and each CHECK inside a duplicate_object guard. The old
-- backend never reads this table, so applying it before the deploy is safe;
-- the new backend answers an empty kit if it is missing.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   DROP TABLE IF EXISTS workspace_brand_kits;
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS "workspace_brand_kits" (
  "workspace_id" uuid PRIMARY KEY REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "colors" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "logo_media_id" uuid REFERENCES "media_items" ("id") ON DELETE SET NULL,
  "adjust_presets" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "updated_by_id" uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE "workspace_brand_kits"
    ADD CONSTRAINT "workspace_brand_kits_colors_array_chk"
    CHECK (jsonb_typeof("colors") = 'array');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "workspace_brand_kits"
    ADD CONSTRAINT "workspace_brand_kits_presets_array_chk"
    CHECK (jsonb_typeof("adjust_presets") = 'array');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
