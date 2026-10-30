-- 0047 - inbox_conversations: one row per inbox thread, with triage state.
--
-- WHY
-- The conversation API lists threads, not messages. This table holds the
-- per-thread state a message row cannot: status (to_reply / later / done),
-- snooze, assignee, unread and item counts, last-message summary, the
-- participant, and a denormalised search_text. (workspace_id, thread_key) is
-- unique and matches inbox_items.thread_key (0046).
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction. Everything is
-- idempotent and non-destructive: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF
-- NOT EXISTS. New table only; no existing table or row is touched. No
-- CONCURRENTLY.
--
-- ROLLBACK
--   DROP TABLE IF EXISTS inbox_conversations;
--
-- Never run `db:push` against prod. The boot migrator applies this file.

CREATE TABLE IF NOT EXISTS "inbox_conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "channel_id" integer NOT NULL REFERENCES "social_media_channels" ("id") ON DELETE CASCADE,
  "platform" varchar(20) NOT NULL,
  "kind" varchar(16) NOT NULL,
  "thread_key" text NOT NULL,
  "status" varchar(10) NOT NULL DEFAULT 'to_reply',
  "later_until" timestamptz,
  "later_until_reply" boolean NOT NULL DEFAULT false,
  "assignee_user_id" uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  "assigned_by_user_id" uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  "done_by_user_id" uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  "assigned_at" timestamptz,
  "done_at" timestamptz,
  "done_via" varchar(10),
  "unread_count" integer NOT NULL DEFAULT 0,
  "item_count" integer NOT NULL DEFAULT 0,
  "last_message_at" timestamptz NOT NULL,
  "last_inbound_at" timestamptz,
  "last_outbound_at" timestamptz,
  "last_snippet" text,
  "last_author_label" text,
  "last_from_me" boolean NOT NULL DEFAULT false,
  "reply_window_closes_at" timestamptz,
  "post_id" uuid REFERENCES "posts" ("id") ON DELETE SET NULL,
  "title" text,
  "thumbnail_url" text,
  "participant_handle" text,
  "participant_name" text,
  "participant_avatar_url" text,
  "participant_platform_id" text,
  "search_text" text NOT NULL DEFAULT '',
  "archived_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "inbox_conversations_kind_chk"
    CHECK ("kind" IN ('comment_thread', 'dm', 'mention')),
  CONSTRAINT "inbox_conversations_status_chk"
    CHECK ("status" IN ('to_reply', 'later', 'done')),
  CONSTRAINT "inbox_conversations_done_via_chk"
    CHECK ("done_via" IS NULL OR "done_via" IN ('reply', 'manual', 'platform')),
  CONSTRAINT "inbox_conversations_later_chk"
    CHECK ("status" <> 'later' OR "later_until" IS NOT NULL OR "later_until_reply")
);

CREATE UNIQUE INDEX IF NOT EXISTS "inbox_conversations_ws_key_uq"
  ON "inbox_conversations" ("workspace_id", "thread_key");

CREATE INDEX IF NOT EXISTS "inbox_conversations_view_idx"
  ON "inbox_conversations" ("workspace_id", "status", "last_message_at" DESC, "id" DESC)
  WHERE "archived_at" IS NULL;

CREATE INDEX IF NOT EXISTS "inbox_conversations_assignee_idx"
  ON "inbox_conversations" ("workspace_id", "assignee_user_id");

CREATE INDEX IF NOT EXISTS "inbox_conversations_later_idx"
  ON "inbox_conversations" ("later_until")
  WHERE "status" = 'later';

CREATE INDEX IF NOT EXISTS "inbox_conversations_kind_idx"
  ON "inbox_conversations" ("workspace_id", "kind");

CREATE INDEX IF NOT EXISTS "inbox_conversations_search_trgm_idx"
  ON "inbox_conversations" USING gin ("search_text" gin_trgm_ops);
