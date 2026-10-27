-- 0046 - inbox_items.thread_key: the conversation a row belongs to.
--
-- WHY
-- The conversation API groups inbox rows into threads: a DM conversation, the
-- comments on one post, or one mention and our replies to it. Deriving that
-- key in application code at every write site lets writers drift, so it is a
-- STORED GENERATED column, always consistent with the row. A mention is keyed
-- by its PLATFORM item id (metadata.mentionRoot for our replies), not the row
-- uuid, so a deleted-and-re-ingested mention re-attaches to the same thread.
-- The extra indexes serve thread loading, per-author lookups, "authored by a
-- teammate" scans and trigram search. pg_trgm is a trusted extension.
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction. Everything is
-- idempotent. Adding a stored generated column rewrites inbox_items under an
-- exclusive lock (seconds at current size); afterwards the value can never
-- disagree with the row. No existing column or row is changed or dropped.
-- No CONCURRENTLY (not allowed in a transaction).
--
-- ROLLBACK
--   DROP INDEX IF EXISTS inbox_items_search_trgm_idx;
--   DROP INDEX IF EXISTS inbox_items_ws_authored_idx;
--   DROP INDEX IF EXISTS inbox_items_author_idx;
--   DROP INDEX IF EXISTS inbox_items_ws_thread_idx;
--   ALTER TABLE inbox_items DROP COLUMN IF EXISTS thread_key;
--
-- Never run `db:push` against prod. The boot migrator applies this file.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE "inbox_items"
  ADD COLUMN IF NOT EXISTS "thread_key" text GENERATED ALWAYS AS (
    CASE
      WHEN "type" = 'dm' THEN "channel_id"::text || ':' || "conversation_id"
      WHEN "platform_post_id" IS NOT NULL THEN "channel_id"::text || ':' || "platform_post_id"
      ELSE "channel_id"::text || ':mention:' || COALESCE("metadata"->>'mentionRoot', "platform_item_id")
    END
  ) STORED;

CREATE INDEX IF NOT EXISTS "inbox_items_ws_thread_idx"
  ON "inbox_items" ("workspace_id", "thread_key", "platform_created_at");

CREATE INDEX IF NOT EXISTS "inbox_items_author_idx"
  ON "inbox_items" ("workspace_id", "author_platform_id");

CREATE INDEX IF NOT EXISTS "inbox_items_ws_authored_idx"
  ON "inbox_items" ("workspace_id", "platform_created_at")
  WHERE "authored_by_user_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "inbox_items_search_trgm_idx"
  ON "inbox_items" USING gin (
    (coalesce("text", '') || ' ' || coalesce("author_handle", '') || ' ' || coalesce("author_display_name", '')) gin_trgm_ops
  );
