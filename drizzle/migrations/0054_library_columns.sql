-- 0054 - Library: alt text, storage provider, page count, folder kinds,
-- per-plan storage limits, share-lookup indexes.
--
-- WHY
-- The redesigned Library needs:
--   1. media_items.alt_text, media_items.page_count (PDF pages) and
--      media_items.storage_provider ('cloudinary' | 'r2'), so deleting a file
--      no longer guesses its store from the URL (D3). Legacy composer videos
--      on R2 are backfilled to 'r2': a URL that is not Cloudinary's, plus
--      either an R2 key as the public id or an R2 key in the URL path.
--      CloudflareR2Service builds the public URL as `<publicBase>/<key>` with
--      key `composer/videos/<workspaceId>/...`, and publicBase is a custom
--      domain or `https://<account>.r2.cloudflarestorage.com/<bucket>`, so
--      every such URL contains `/composer/videos/`. Rows written with a NULL
--      public id are caught by the URL arm. Any R2 row this misses is still
--      deleted from R2: StorageObjectService.deleteFile trusts an R2 URL over
--      a 'cloudinary' column value.
--   2. Indexes on media_items(file_url), media_items(thumbnail_url) and
--      media_items(cloudinary_public_id) (SEC3): the share check
--      (StorageObjectService.findSharedFiles on purge, isFileShared on a 413 or
--      orphan cleanup) looks rows up by these across ALL workspaces, which
--      otherwise is a sequential scan per purge page or refused upload.
--      thumbnail_url is matched because a video's poster is a file another row
--      may still show. file_url and thumbnail_url are HASH indexes: the
--      lookups are equality only (= / IN), and both are unbounded text, so a
--      btree would refuse (at build time, or later on INSERT) any URL over its
--      ~2.7 kB entry limit. cloudinary_public_id is varchar(255), so a plain
--      btree is safe.
--   3. The snippet type 'bio' is renamed 'signature'.
--   4. saved_links.utm (jsonb) and saved_links.preview_favicon_url.
--   5. plans.storage_bytes_per_workspace with each plan's value (FREE 500 MB,
--      BASIC 2 GB, PRO 10 GB, MAX 25 GB). Seeds do not run on deploy, so this
--      file writes them itself.
--   6. workspace_usage.storage_bytes_limit (backfilled from the workspace
--      owner's plan, counted only while the subscription is 'active' or
--      'trialing' (owner ruling 2026-10-31: a trial counts as active for
--      storage); anything else is FREE, D14/B7) and
--      workspace_usage.extra_storage_purchased
--      (bought add-on bytes; this file never writes it).
--   7. Folder kinds (D7): the four legacy media folder types image / gif /
--      video / document become one 'media' kind. Same-named folders in one
--      workspace would collide, so all but the first (by kind image, gif,
--      video, document, then created_at, then id) get a suffix: " (Images)",
--      " (GIFs)", " (Videos)", " (Docs)". display_order is renumbered from 0
--      per workspace by (kind, display_order, name). Folder ids do not change,
--      so every item keeps its category_id. Template, snippet and link folders
--      are not touched.
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY. Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT
-- EXISTS, the CHECK constraint inside a duplicate_object guard, and every data
-- update touches only legacy values (storage_provider still 'cloudinary',
-- snippet_type 'bio', a plan or workspace whose value differs, folder types
-- image/gif/video/document), so a second run changes nothing.
-- Every ADD COLUMN ... DEFAULT uses a constant default, which Postgres 11+
-- stores as metadata: no table rewrite. The CHECK constraint scans media_items
-- once to validate it (already under the ADD COLUMN's lock). Nothing is
-- dropped or deleted.
--
-- LOCKS AND COST
-- `SET LOCAL lock_timeout = '10s'` comes first (I4). The ALTERs take ACCESS
-- EXCLUSIVE on media_items, saved_links, plans and workspace_usage until
-- COMMIT; without the timeout they would queue behind any open transaction on
-- the still-running old instance and every Library / billing read would queue
-- behind them. With it a blocked deploy fails fast and rolls back; retry the
-- deploy. The three CREATE INDEX statements build inside that lock: one
-- sequential scan of media_items each. Fine at current scale; check
-- media_items' row count before deploying if it has grown by orders of
-- magnitude.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   DROP INDEX IF EXISTS media_items_file_url_idx;
--   DROP INDEX IF EXISTS media_items_thumbnail_url_idx;
--   DROP INDEX IF EXISTS media_items_cloudinary_public_id_idx;
--   ALTER TABLE media_items DROP CONSTRAINT IF EXISTS media_items_storage_provider_chk;
--   ALTER TABLE media_items DROP COLUMN IF EXISTS alt_text,
--     DROP COLUMN IF EXISTS storage_provider, DROP COLUMN IF EXISTS page_count;
--   ALTER TABLE saved_links DROP COLUMN IF EXISTS utm,
--     DROP COLUMN IF EXISTS preview_favicon_url;
--   ALTER TABLE plans DROP COLUMN IF EXISTS storage_bytes_per_workspace;
--   ALTER TABLE workspace_usage DROP COLUMN IF EXISTS storage_bytes_limit,
--     DROP COLUMN IF EXISTS extra_storage_purchased;
--   NOT reversible: the folder merge (the old per-type folder kind and the
--   pre-suffix names are not kept) and the 'bio' -> 'signature' rename (a
--   'signature' row cannot be told apart from one that was 'bio').
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

-- 1. media_items -------------------------------------------------------------

ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "alt_text" text;
ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "storage_provider" varchar(20) NOT NULL DEFAULT 'cloudinary';
ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "page_count" integer;

DO $$ BEGIN
  ALTER TABLE "media_items" ADD CONSTRAINT "media_items_storage_provider_chk"
    CHECK ("storage_provider" IN ('cloudinary', 'r2'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Legacy composer videos uploaded to R2 (D3; see WHY 1).
UPDATE "media_items"
   SET "storage_provider" = 'r2'
 WHERE "storage_provider" = 'cloudinary'
   AND "file_url" NOT LIKE 'https://res.cloudinary.com/%'
   AND ("cloudinary_public_id" LIKE 'composer/videos/%'
        OR "file_url" LIKE '%/composer/videos/%');

-- Share lookups across workspaces (SEC3). See WHY 2 for the hash index.
CREATE INDEX IF NOT EXISTS "media_items_file_url_idx"
  ON "media_items" USING hash ("file_url");
CREATE INDEX IF NOT EXISTS "media_items_thumbnail_url_idx"
  ON "media_items" USING hash ("thumbnail_url");
CREATE INDEX IF NOT EXISTS "media_items_cloudinary_public_id_idx"
  ON "media_items" USING btree ("cloudinary_public_id");

-- 2. text_snippets -----------------------------------------------------------

UPDATE "text_snippets" SET "snippet_type" = 'signature' WHERE "snippet_type" = 'bio';

-- 3. saved_links -------------------------------------------------------------

ALTER TABLE "saved_links" ADD COLUMN IF NOT EXISTS "utm" jsonb;
ALTER TABLE "saved_links" ADD COLUMN IF NOT EXISTS "preview_favicon_url" text;

-- 4. plans -------------------------------------------------------------------

ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "storage_bytes_per_workspace" bigint NOT NULL DEFAULT 524288000;

UPDATE "plans"
   SET "storage_bytes_per_workspace" = v.b
  FROM (VALUES ('FREE', 524288000::bigint),
               ('BASIC', 2147483648::bigint),
               ('PRO', 10737418240::bigint),
               ('MAX', 26843545600::bigint)) AS v(code, b)
 WHERE "plans"."code" = v.code
   AND "plans"."storage_bytes_per_workspace" <> v.b;

-- 5. workspace_usage ---------------------------------------------------------

ALTER TABLE "workspace_usage" ADD COLUMN IF NOT EXISTS "storage_bytes_limit" bigint NOT NULL DEFAULT 524288000;
ALTER TABLE "workspace_usage" ADD COLUMN IF NOT EXISTS "extra_storage_purchased" bigint NOT NULL DEFAULT 0;

-- The owner's plan counts only while the subscription is active or trialing
-- (B7; a trial counts as active, owner ruling 2026-10-31), the same rule as
-- StorageQuotaService. No subscription, any other status, or a plan code with
-- no row -> FREE.
UPDATE "workspace_usage" wu
   SET "storage_bytes_limit" = t.limit_bytes
  FROM (
    SELECT u.id,
           COALESCE(
             p.storage_bytes_per_workspace,
             (SELECT f.storage_bytes_per_workspace FROM plans f WHERE f.code = 'FREE'),
             524288000
           ) AS limit_bytes
      FROM workspace_usage u
      JOIN workspace w ON w.id = u.workspace_id
      LEFT JOIN subscriptions s ON s.user_id = w.owner_id
      LEFT JOIN plans p
        ON p.code = COALESCE(CASE WHEN s.status IN ('active', 'trialing') THEN s.plan_code END, 'FREE')
  ) t
 WHERE wu.id = t.id
   AND wu.storage_bytes_limit IS DISTINCT FROM t.limit_bytes;

-- 6. media_categories: one 'media' folder kind (D7) --------------------------

WITH legacy AS (
  SELECT id, workspace_id, name, type, display_order, created_at,
         CASE type
           WHEN 'image' THEN 1
           WHEN 'gif' THEN 2
           WHEN 'video' THEN 3
           ELSE 4
         END AS kind_rank,
         CASE type
           WHEN 'image' THEN ' (Images)'
           WHEN 'gif' THEN ' (GIFs)'
           WHEN 'video' THEN ' (Videos)'
           ELSE ' (Docs)'
         END AS suffix
    FROM media_categories
   WHERE type IN ('image', 'gif', 'video', 'document')
),
ranked AS (
  SELECT l.*,
         row_number() OVER (PARTITION BY workspace_id, name
                            ORDER BY kind_rank, created_at, id) AS name_rank,
         row_number() OVER (PARTITION BY workspace_id
                            ORDER BY kind_rank, display_order, name, id) - 1 AS new_order
    FROM legacy l
)
UPDATE "media_categories" c
   SET "name" = CASE WHEN r.name_rank > 1
                     THEN left(r.name, 100 - length(r.suffix)) || r.suffix
                     ELSE r.name END,
       "display_order" = r.new_order,
       "type" = 'media'
  FROM ranked r
 WHERE c.id = r.id;
