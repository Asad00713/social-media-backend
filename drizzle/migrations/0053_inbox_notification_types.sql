-- 0053 - notification types for the redesigned Inbox (R7).
--
-- WHY
-- Assigning a conversation, mentioning someone in a note and a new inbound
-- message each raise a bell notification, so notification_type needs
-- 'inbox_assigned', 'inbox_note_mention' and 'inbox_new_message'.
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction. ADD VALUE IF NOT EXISTS
-- is idempotent, and the new values are not used in this transaction, which
-- Postgres requires. Nothing is dropped, rewritten or read. No CONCURRENTLY.
--
-- ROLLBACK
--   (an enum value cannot be dropped; the three values are harmless if left)
--
-- Never run `db:push` against prod. The boot migrator applies this file.

ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'inbox_assigned' BEFORE 'system_announcement';
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'inbox_note_mention' BEFORE 'system_announcement';
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'inbox_new_message' BEFORE 'system_announcement';
