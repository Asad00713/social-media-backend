-- 0056 - Library folders record who created them.
--
-- WHY
-- Teams share the Library, so every folder shows "Created by" the way media
-- (uploaded_by_id), templates, snippets and links (created_by_id) already do.
-- media_categories had no creator column. This adds
-- media_categories.created_by_id, set by POST categories from the signed-in
-- user. There is no backfill: nothing records who made an existing folder, so
-- those stay NULL and the API returns `createdBy: null` for them.
--
-- The column is nullable with ON DELETE SET NULL (unlike the items' NOT NULL
-- CASCADE): a folder is shared by the team, so deleting the user who made it
-- must not delete it, and old folders have no creator at all.
-- The index serves the ON DELETE SET NULL lookup when a user is deleted, the
-- same as every other *_by_id column on the Library tables.
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY. Additive and idempotent: ADD COLUMN IF NOT EXISTS (a second
-- run skips the column and its foreign key together) and CREATE INDEX IF NOT
-- EXISTS. The column is nullable with no default, so no table rewrite; the
-- foreign key's validation scans a column that is NULL on every row. No row is
-- read or written. The running backend selects named columns only, so it is
-- unaffected by the new column: this is safe to apply on start, before or
-- after the code that writes it.
--
-- LOCKS AND COST
-- `SET LOCAL lock_timeout = '10s'` comes first (I4). The ALTER takes ACCESS
-- EXCLUSIVE on media_categories, and the foreign key a SHARE ROW EXCLUSIVE on
-- users, until COMMIT; without the timeout they would queue behind any open
-- transaction on the still-running old instance, and every folder read and
-- every write to users would queue behind them. With it a blocked deploy fails fast
-- and rolls back; retry the deploy. The index build is one scan of
-- media_categories, a small table (folders per workspace).
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   DROP INDEX IF EXISTS media_categories_created_by_id_idx;
--   ALTER TABLE media_categories DROP COLUMN IF EXISTS created_by_id;
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

ALTER TABLE "media_categories"
  ADD COLUMN IF NOT EXISTS "created_by_id" uuid REFERENCES "users" ("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "media_categories_created_by_id_idx"
  ON "media_categories" USING btree ("created_by_id");
