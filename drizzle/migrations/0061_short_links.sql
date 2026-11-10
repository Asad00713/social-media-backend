-- 0061 - Short links: the composer Link panel's "Shorten the link" row.
--
-- WHY
-- The composer's Link panel (Figma 4224:8153) shortens a URL in a caption
-- and shows how many people clicked it. That needs a redirect store we own:
-- one row per shortened URL per workspace, read by the public `GET /l/:code`
-- redirect and counted there.
--   workspace_id    the tenant (cascade: a deleted workspace takes its links)
--   code            the short path segment, base62 (CHECK); unique app-wide
--                   because the redirect knows nothing but the code
--   target_url      where it goes. http(s) only and at most 2048 characters
--                   (CHECKs); the API validates and normalises it first, the
--                   CHECKs are the backstop against a `javascript:` target
--   post_id         the post it was made for, if the draft was saved; SET
--                   NULL so a deleted post does not break a published link
--   created_by_id   who made it; SET NULL when that user is deleted
--   clicks          redirects served, incremented in the UPDATE itself
--   last_clicked_at the latest of them; NULL until the first click
-- Creating is idempotent per workspace and URL: (workspace_id, target_url)
-- is unique, so shortening the same address twice returns the same code.
-- No per-click table: no IP, user agent or referrer is stored.
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY. New table only: no existing table is altered, no row is
-- read, written or dropped. The foreign keys take a SHARE ROW EXCLUSIVE lock
-- on workspace, posts and users for the length of this transaction (they
-- are validated against an empty table, so it is instant); `lock_timeout`
-- bounds the wait behind the still-running old instance (I4). Idempotent:
-- CREATE TABLE / INDEX IF NOT EXISTS and each CHECK inside a
-- duplicate_object guard. The old backend never reads this table, so
-- applying it before the deploy is safe; the new backend answers 503 on
-- create and 404 on redirect if it is missing.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   DROP TABLE IF EXISTS short_links;
--   (every short link already published in a post stops redirecting)
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS "short_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "code" text NOT NULL,
  "target_url" text NOT NULL,
  "post_id" uuid REFERENCES "posts" ("id") ON DELETE SET NULL,
  "created_by_id" uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "clicks" integer NOT NULL DEFAULT 0,
  "last_clicked_at" timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS "short_links_code_key"
  ON "short_links" ("code");

CREATE UNIQUE INDEX IF NOT EXISTS "short_links_workspace_id_target_url_key"
  ON "short_links" ("workspace_id", "target_url");

CREATE INDEX IF NOT EXISTS "short_links_workspace_id_created_at_idx"
  ON "short_links" ("workspace_id", "created_at");

CREATE INDEX IF NOT EXISTS "short_links_post_id_idx"
  ON "short_links" ("post_id")
  WHERE "post_id" IS NOT NULL;

DO $$
BEGIN
  ALTER TABLE "short_links"
    ADD CONSTRAINT "short_links_code_format_chk"
    CHECK ("code" ~ '^[0-9A-Za-z]{4,16}$');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "short_links"
    ADD CONSTRAINT "short_links_target_url_chk"
    CHECK (
      char_length("target_url") <= 2048
      AND "target_url" ~* '^https?://[^/?#[:space:]]+'
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "short_links"
    ADD CONSTRAINT "short_links_clicks_chk"
    CHECK ("clicks" >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
