-- 0094 - Label catalogue and the post-to-label join table, with a backfill.
--
-- WHY
-- Labels lived only as free strings in posts.metadata.labels, so renaming or
-- merging one meant rewriting every post that carried it, racing composer
-- saves. The Settings redesign gives a workspace a real catalogue:
--   workspace_labels  one row per label: name, colour (a fixed palette of
--                     eight), optional description. Deleting is soft
--                     (deleted_at) so the 10-second undo can restore it.
--                     Names are unique per workspace, case-insensitively,
--                     among live labels only (partial unique index).
--   post_labels       the join: which labels a post carries. Rows cascade
--                     away with the post or the label.
-- The backfill turns every distinct (workspace, lower(name)) found in
-- posts.metadata.labels into a catalogue row (first-seen spelling, by
-- posts.created_at; colours handed out in palette order, per workspace, by
-- first sighting) and then writes one post_labels row per (post, label).
-- Names are cleaned the way normaliseLabels does it: whitespace collapsed,
-- then trimmed; empty names and names over 40 characters are dropped, and
-- anything in the array that is not a string is ignored. A metadata.labels
-- that is not an array is skipped.
-- posts.metadata.labels is LEFT IN PLACE and is no longer read or written
-- once the new backend serves traffic (removing it is a follow-up). Labels
-- written by the OLD instance between this migration and the switch-over are
-- not copied: the window is seconds long and the loss is accepted.
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY. Every lock is held until that transaction commits, so the
-- order of the statements decides who waits and for how long.
--   1. Both tables are new, so there is nothing to rewrite. They are created
--      WITHOUT foreign keys: a foreign key takes SHARE ROW EXCLUSIVE on the
--      table it references, and taken up front it would hold posts and
--      workspace against every write (a save, a publish, a settings change)
--      for the whole backfill below.
--   2. The backfill READS posts (ACCESS SHARE, which blocks no reader and no
--      writer) and inserts into the two new tables, which nobody else uses
--      yet. It is set-based: two INSERT ... SELECT statements, no row-by-row
--      loop. Soft-deleted posts are skipped: their labels are not carried
--      into the catalogue. So are posts of a soft-deleted WORKSPACE: the
--      purge may hard-delete that workspace and its posts at any moment,
--      and a row written for them between the backfill and step 3's
--      foreign keys would be an orphan no key ever saw (0097 also deletes
--      any such orphan before it validates, as the second line of defence).
--   3. Last, the four foreign keys are added NOT VALID: catalog-only, no
--      scan, so SHARE ROW EXCLUSIVE on posts, workspace, users and
--      workspace_labels is held from that statement to the commit right
--      after it, not through the backfill. `lock_timeout` (10 s) bounds each
--      wait behind the still-running old instance (I4); if it trips, the
--      whole file rolls back. New rows are checked from here on.
--   4. 0097_users_fk_validate.sql validates them in its own transaction:
--      VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE on the table it
--      checks and ROW SHARE on the referenced one, which blocks no writer.
--   5. The old backend never touches the new tables, so applying this before
--      the deploy is safe.
-- Idempotent: CREATE ... IF NOT EXISTS, and both backfill INSERTs carry
-- ON CONFLICT DO NOTHING, so running the file again adds nothing. The label
-- CTE is written out twice (once per INSERT) because a CTE cannot span two
-- statements.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   DROP TABLE IF EXISTS post_labels;
--   DROP TABLE IF EXISTS workspace_labels;
--   (drops the catalogue and every label assignment made since; the original
--   strings are still in posts.metadata.labels)
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS "workspace_labels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL,
  "name" varchar(40) NOT NULL,
  "color" text NOT NULL
    CHECK ("color" IN ('blue', 'orange', 'green', 'purple', 'pink', 'teal', 'red', 'grey')),
  "description" varchar(120),
  "created_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_labels_name_uq"
  ON "workspace_labels" ("workspace_id", lower("name"))
  WHERE "deleted_at" IS NULL;

CREATE TABLE IF NOT EXISTS "post_labels" (
  "post_id" uuid NOT NULL,
  "label_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("post_id", "label_id")
);

CREATE INDEX IF NOT EXISTS "post_labels_label_idx"
  ON "post_labels" ("label_id");

-- Backfill 1/2: the catalogue. One row per (workspace, lower(name)); the
-- first sighting (oldest post, then the label's position in its array) fixes
-- the spelling, the created_at and the colour's place in the palette.
INSERT INTO "workspace_labels" ("workspace_id", "name", "color", "created_at")
SELECT
  f."workspace_id",
  f."name",
  (ARRAY['blue', 'orange', 'green', 'purple', 'pink', 'teal', 'red', 'grey']::text[])[
    (((row_number() OVER (
        PARTITION BY f."workspace_id"
        ORDER BY f."post_created_at", f."post_id", f."ord", f."key"
      ) - 1) % 8) + 1)::int
  ],
  COALESCE(f."post_created_at", now())
FROM (
  SELECT DISTINCT ON (o."workspace_id", o."key") o.*
  FROM (
    SELECT c.*, lower(c."name") AS "key"
    FROM (
      SELECT
        p."workspace_id",
        p."id" AS "post_id",
        p."created_at" AS "post_created_at",
        e."ord",
        btrim(regexp_replace(e."value" #>> '{}', '\s+', ' ', 'g')) AS "name"
      FROM "posts" p
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(p."metadata" -> 'labels') = 'array'
            THEN p."metadata" -> 'labels'
          ELSE '[]'::jsonb
        END
      ) WITH ORDINALITY AS e ("value", "ord")
      WHERE jsonb_typeof(e."value") = 'string'
        AND p."deleted_at" IS NULL
        AND EXISTS (
          SELECT 1 FROM "workspace" ws
           WHERE ws."id" = p."workspace_id" AND ws."deleted_at" IS NULL
        )
    ) c
    WHERE c."name" <> '' AND char_length(c."name") <= 40
  ) o
  ORDER BY o."workspace_id", o."key", o."post_created_at", o."post_id", o."ord"
) f
ON CONFLICT ("workspace_id", lower("name")) WHERE "deleted_at" IS NULL
DO NOTHING;

-- Backfill 2/2: one post_labels row per (post, label). Same CTE as above,
-- joined to the live catalogue on (workspace, lower(name)).
INSERT INTO "post_labels" ("post_id", "label_id", "created_at")
SELECT DISTINCT o."post_id", l."id", COALESCE(o."post_created_at", now())
FROM (
  SELECT c.*, lower(c."name") AS "key"
  FROM (
    SELECT
      p."workspace_id",
      p."id" AS "post_id",
      p."created_at" AS "post_created_at",
      btrim(regexp_replace(e."value" #>> '{}', '\s+', ' ', 'g')) AS "name"
    FROM "posts" p
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(p."metadata" -> 'labels') = 'array'
          THEN p."metadata" -> 'labels'
        ELSE '[]'::jsonb
      END
    ) AS e ("value")
    WHERE jsonb_typeof(e."value") = 'string'
      AND p."deleted_at" IS NULL
      AND EXISTS (
        SELECT 1 FROM "workspace" ws
         WHERE ws."id" = p."workspace_id" AND ws."deleted_at" IS NULL
      )
  ) c
  WHERE c."name" <> '' AND char_length(c."name") <= 40
) o
JOIN "workspace_labels" l
  ON l."workspace_id" = o."workspace_id"
 AND lower(l."name") = o."key"
 AND l."deleted_at" IS NULL
ON CONFLICT DO NOTHING;

-- The foreign keys, last and NOT VALID (SAFETY 3); 0097 validates them. The
-- names are the ones an inline REFERENCES would have given, so a database
-- that ran an earlier draft of this file (FKs inline) skips them here.
DO $$
BEGIN
  ALTER TABLE "workspace_labels"
    ADD CONSTRAINT "workspace_labels_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace" ("id")
    ON DELETE CASCADE NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "workspace_labels"
    ADD CONSTRAINT "workspace_labels_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users" ("id")
    ON DELETE SET NULL NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "post_labels"
    ADD CONSTRAINT "post_labels_post_id_fkey"
    FOREIGN KEY ("post_id") REFERENCES "posts" ("id")
    ON DELETE CASCADE NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "post_labels"
    ADD CONSTRAINT "post_labels_label_id_fkey"
    FOREIGN KEY ("label_id") REFERENCES "workspace_labels" ("id")
    ON DELETE CASCADE NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
