-- 0041 - Planner "ready" flag on drafts, and the draft_ready notification type.
--
-- WHY
-- A teammate can mark a draft "ready to schedule"; MEMBER+ are notified and the
-- Planner's Approvals tab lists them. That needs who/when (ready_at,
-- ready_by_id), a partial index for the Drafts panel (workspace, newest edit
-- first), and a notification type. The flag must clear whenever a post leaves
-- 'draft' (spec 7.3) no matter which writer moved it (PostService, composer
-- scheduling, publish orchestrator, campaigns, first-week), so a trigger does
-- it once instead of patching every writer.
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction. Everything is
-- idempotent and non-destructive:
--   * ADD COLUMN / CREATE INDEX IF NOT EXISTS; both columns are nullable, no
--     default, so no table rewrite.
--   * ADD VALUE IF NOT EXISTS for the enum (the new value is not used in this
--     transaction, which Postgres requires).
--   * CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS + CREATE TRIGGER.
--   * Nothing is dropped from existing data and no rows are read or rewritten.
--
-- ROLLBACK
--   DROP TRIGGER IF EXISTS posts_clear_ready ON posts;
--   DROP FUNCTION IF EXISTS posts_clear_ready();
--   DROP INDEX IF EXISTS posts_workspace_draft_idx;
--   ALTER TABLE posts DROP COLUMN IF EXISTS ready_by_id, DROP COLUMN IF EXISTS ready_at;
--   (an enum value cannot be dropped; 'draft_ready' is harmless if left)
--
-- Never run `db:push` against prod. The boot migrator applies this file.

ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "ready_at" timestamptz;

ALTER TABLE "posts"
  ADD COLUMN IF NOT EXISTS "ready_by_id" uuid REFERENCES "users" ("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "posts_workspace_draft_idx"
  ON "posts" ("workspace_id", "updated_at" DESC)
  WHERE "status" = 'draft';

ALTER TYPE "public"."notification_type"
  ADD VALUE IF NOT EXISTS 'draft_ready' BEFORE 'system_announcement';

CREATE OR REPLACE FUNCTION posts_clear_ready() RETURNS trigger AS $$
BEGIN
  NEW.ready_at := NULL;
  NEW.ready_by_id := NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS posts_clear_ready ON "posts";

CREATE TRIGGER posts_clear_ready
  BEFORE UPDATE ON "posts"
  FOR EACH ROW
  WHEN (NEW.status <> 'draft' AND NEW.ready_at IS NOT NULL)
  EXECUTE FUNCTION posts_clear_ready();
