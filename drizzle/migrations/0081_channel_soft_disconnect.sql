-- 0081 - Soft disconnect: a disconnected channel keeps its history.
--
-- WHY
-- Disconnect used to hard-delete the channel row, and the foreign-key
-- cascades took its insights, inbox and sync history with it. A disconnect
-- now keeps the row as history (connection_status 'disconnected'), pauses
-- its scheduled posts instead of failing them, and can be undone for
-- CHANNEL_RESTORE_WINDOW_MS (10 minutes). After that window a finalize job
-- clears the tokens - or deletes the row, for platforms whose developer
-- policy requires the data to go (channels/lib/disconnect-policy.ts).
--
-- Four columns on social_media_channels, all NULL on every existing row:
--   disconnected_at          when the user disconnected it; NULL = not.
--   disconnected_by_user_id  who did (users, ON DELETE SET NULL).
--   status_before_disconnect what an undo puts back ('connected', 'expired'..).
--   disconnect_finalized_at  when the finalize job cleared the tokens; an
--                            undo is refused from then on.
-- One CHECK keeps the marker and the status in step:
--   connection_status = 'disconnected'  <=>  disconnected_at IS NOT NULL
-- so a writer that flips the status of a disconnected row back to
-- 'connected' / 'expired' (a token refresh, an error mark) fails loudly
-- instead of silently resurrecting the channel.
-- One partial index serves the finalize sweep (rows disconnected and not
-- finalized yet).
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY. Locks, in order:
--   1. ADD COLUMN (nullable, no default) is catalog-only, under ACCESS
--      EXCLUSIVE on social_media_channels. `lock_timeout` (10 s) bounds the
--      wait behind the still-running old instance; if it trips the whole file
--      rolls back.
--   2. The foreign key on disconnected_by_user_id takes SHARE ROW EXCLUSIVE on
--      `users` and validates by scanning social_media_channels (every value
--      is NULL, so no lookup into users).
--   3. The CHECK is validated by one scan of social_media_channels: no
--      existing row is 'disconnected' (the old code never wrote it) and every
--      disconnected_at is NULL, so it holds on every row.
--   4. CREATE INDEX (not CONCURRENTLY) on a partial predicate no existing row
--      matches: an empty index, built by one scan.
-- No existing row is written or dropped. The old backend never writes
-- 'disconnected' and never reads the new columns (drizzle selects only the
-- columns its schema names), so applying this before the deploy is safe.
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, each
-- constraint inside a duplicate_object guard.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK (only before any channel was soft-disconnected; a disconnected row
-- would otherwise come back as a channel with no tokens):
--   DROP INDEX IF EXISTS channels_disconnect_pending_idx;
--   ALTER TABLE social_media_channels
--     DROP CONSTRAINT IF EXISTS social_media_channels_disconnected_chk,
--     DROP COLUMN IF EXISTS disconnect_finalized_at,
--     DROP COLUMN IF EXISTS status_before_disconnect,
--     DROP COLUMN IF EXISTS disconnected_by_user_id,
--     DROP COLUMN IF EXISTS disconnected_at;
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

ALTER TABLE "social_media_channels"
  ADD COLUMN IF NOT EXISTS "disconnected_at" timestamptz;

ALTER TABLE "social_media_channels"
  ADD COLUMN IF NOT EXISTS "disconnected_by_user_id" uuid;

ALTER TABLE "social_media_channels"
  ADD COLUMN IF NOT EXISTS "status_before_disconnect" varchar(20);

ALTER TABLE "social_media_channels"
  ADD COLUMN IF NOT EXISTS "disconnect_finalized_at" timestamptz;

DO $$
BEGIN
  ALTER TABLE "social_media_channels"
    ADD CONSTRAINT "social_media_channels_disconnected_by_user_id_fkey"
    FOREIGN KEY ("disconnected_by_user_id") REFERENCES "users" ("id")
    ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "social_media_channels"
    ADD CONSTRAINT "social_media_channels_disconnected_chk"
    CHECK (("connection_status" = 'disconnected') = ("disconnected_at" IS NOT NULL));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "channels_disconnect_pending_idx"
  ON "social_media_channels" ("disconnected_at")
  WHERE "disconnected_at" IS NOT NULL AND "disconnect_finalized_at" IS NULL;
