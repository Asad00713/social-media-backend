-- 0048 - inbox_notes: internal team notes on an inbox conversation.
--
-- WHY
-- Teammates need to leave private context (and @mention each other) on a
-- thread without it ever being sent to the customer. mentioned_user_ids holds
-- the resolved mentions.
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction. Everything is
-- idempotent and non-destructive: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF
-- NOT EXISTS. New table only; no existing table or row is touched. No
-- CONCURRENTLY.
--
-- ROLLBACK
--   DROP TABLE IF EXISTS inbox_notes;
--
-- Never run `db:push` against prod. The boot migrator applies this file.

CREATE TABLE IF NOT EXISTS "inbox_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversation_id" uuid NOT NULL REFERENCES "inbox_conversations" ("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "author_user_id" uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  "body" text NOT NULL,
  "mentioned_user_ids" uuid[] NOT NULL DEFAULT '{}',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "inbox_notes_body_chk"
    CHECK (char_length("body") BETWEEN 1 AND 5000)
);

CREATE INDEX IF NOT EXISTS "inbox_notes_conversation_idx"
  ON "inbox_notes" ("conversation_id", "created_at");
