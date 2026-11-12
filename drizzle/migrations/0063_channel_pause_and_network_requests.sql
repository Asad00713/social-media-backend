-- 0063 - Channels page: a real user pause, and "Request a network".
--
-- WHY
-- The redesigned Channels page lets a person pause a channel ("6 scheduled
-- posts wait until you resume. Nothing is deleted.") and resume it later
-- ("2 posts will go out as scheduled."). The only off-switch the table had,
-- `is_active = false`, means LOCKED BY A PLAN DOWNGRADE
-- (billing/services/channel-lock.util.ts) and is recomputed by the billing
-- reconciler, so a user pause cannot share it: an upgrade would silently
-- un-pause, and a pause would read as "upgrade to unlock". Two new nullable
-- columns carry the pause instead:
--   paused_at          when it was paused; NULL = not paused
--   paused_by_user_id  who paused it; SET NULL when that user is deleted
-- A CHECK keeps them coherent: nobody can have paused a channel that is not
-- paused.
--
-- The same page has a "Request a network" form for platforms we do not
-- support yet. network_requests stores one row per request:
--   workspace_id  the tenant (cascade: a deleted workspace takes its rows)
--   user_id       who asked; SET NULL so the request survives the user
--   network       the platform name as typed, 1-60 characters (CHECK)
--   note          optional free text, at most 500 characters (CHECK)
-- The API validates both first; the CHECKs are the backstop. The
-- (user_id, created_at) index serves the per-user rate limit.
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY. ADD COLUMN of a nullable column with no default is a
-- catalog-only change, but it takes ACCESS EXCLUSIVE on social_media_channels
-- for the length of this transaction, and the foreign keys take SHARE ROW
-- EXCLUSIVE on users and workspace; `lock_timeout` bounds the wait behind the
-- still-running old instance (I4). The FK and CHECK validate against columns
-- that are NULL on every existing row, so they are instant. No row is read,
-- written or dropped. Idempotent: ADD COLUMN / CREATE ... IF NOT EXISTS and
-- each constraint inside a duplicate_object guard. The old backend never
-- reads the new columns or table, so applying this before the deploy is safe.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   DROP TABLE IF EXISTS network_requests;
--   ALTER TABLE social_media_channels
--     DROP CONSTRAINT IF EXISTS social_media_channels_paused_by_chk,
--     DROP CONSTRAINT IF EXISTS social_media_channels_paused_by_user_id_fkey,
--     DROP COLUMN IF EXISTS paused_by_user_id,
--     DROP COLUMN IF EXISTS paused_at;
--   (every paused channel resumes; posts held for it stay held until a
--   publish job runs for them again)
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

ALTER TABLE "social_media_channels"
  ADD COLUMN IF NOT EXISTS "paused_at" timestamptz;

ALTER TABLE "social_media_channels"
  ADD COLUMN IF NOT EXISTS "paused_by_user_id" uuid;

DO $$
BEGIN
  ALTER TABLE "social_media_channels"
    ADD CONSTRAINT "social_media_channels_paused_by_user_id_fkey"
    FOREIGN KEY ("paused_by_user_id") REFERENCES "users" ("id")
    ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "social_media_channels"
    ADD CONSTRAINT "social_media_channels_paused_by_chk"
    CHECK ("paused_by_user_id" IS NULL OR "paused_at" IS NOT NULL);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "network_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "user_id" uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  "network" text NOT NULL,
  "note" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "network_requests_user_id_created_at_idx"
  ON "network_requests" ("user_id", "created_at");

CREATE INDEX IF NOT EXISTS "network_requests_workspace_id_created_at_idx"
  ON "network_requests" ("workspace_id", "created_at");

DO $$
BEGIN
  ALTER TABLE "network_requests"
    ADD CONSTRAINT "network_requests_network_chk"
    CHECK (char_length(btrim("network")) BETWEEN 1 AND 60);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "network_requests"
    ADD CONSTRAINT "network_requests_note_chk"
    CHECK ("note" IS NULL OR char_length("note") <= 500);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
