-- 0051 - scheduled_inbox_messages: attachments and a link to the conversation.
--
-- WHY
-- Scheduled replies can carry media, and the conversation view needs to list
-- the replies scheduled on a thread. The table already has conversation_id
-- (the PLATFORM dm id), so the uuid link is inbox_conversation_id.
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction. Additive only: two
-- nullable-or-defaulted columns (ADD COLUMN IF NOT EXISTS; the jsonb default is
-- a constant, so no table rewrite) and one index. The FK is added inside a
-- duplicate_object guard. No CONCURRENTLY.
--
-- ROLLBACK
--   DROP INDEX IF EXISTS scheduled_inbox_conv_status_idx;
--   ALTER TABLE scheduled_inbox_messages
--     DROP CONSTRAINT IF EXISTS scheduled_inbox_messages_inbox_conversation_fk,
--     DROP COLUMN IF EXISTS inbox_conversation_id,
--     DROP COLUMN IF EXISTS attachments;
--
-- Never run `db:push` against prod. The boot migrator applies this file.

ALTER TABLE "scheduled_inbox_messages"
  ADD COLUMN IF NOT EXISTS "attachments" jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "scheduled_inbox_messages"
  ADD COLUMN IF NOT EXISTS "inbox_conversation_id" uuid;

DO $$ BEGIN
  ALTER TABLE "scheduled_inbox_messages"
    ADD CONSTRAINT "scheduled_inbox_messages_inbox_conversation_fk"
    FOREIGN KEY ("inbox_conversation_id")
    REFERENCES "inbox_conversations" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "scheduled_inbox_conv_status_idx"
  ON "scheduled_inbox_messages" ("inbox_conversation_id", "status");
