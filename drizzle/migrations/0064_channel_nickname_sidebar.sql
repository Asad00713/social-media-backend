-- 0064 - Channel page settings: a nickname, and "Show in sidebar".
--
-- WHY
-- The channel page's Settings tab (Figma Section 4c) lets a person rename a
-- channel for their team ("Daybreak Coffee" instead of the Page's legal
-- name) and pin it to the app sidebar. Neither can reuse an existing column:
--   account_name is the platform's own name and every reconnect overwrites
--   it (ChannelService.createChannel's reconnect path), so a rename stored
--   there would silently revert;
--   the sidebar pin was per-browser (localStorage) and must now be the same
--   for the whole workspace.
-- Two new columns:
--   nickname         the team's name for the channel; NULL = use
--                    account_name. 1-80 characters once trimmed (CHECK); the
--                    API trims and validates first, the CHECK is the backstop
--   show_in_sidebar  workspace-wide sidebar pin; false for every existing row
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY. ADD COLUMN of a nullable column is catalog-only, and so is a
-- NOT NULL column with a constant DEFAULT (PG 11+: the default is stored in
-- the catalog, no table rewrite). Both still take ACCESS EXCLUSIVE on
-- social_media_channels for the length of this transaction; `lock_timeout`
-- bounds the wait behind the still-running old instance (I4). The CHECK
-- validates against a column that is NULL on every existing row, so it is
-- instant. No row is read, written or dropped. Idempotent: ADD COLUMN IF NOT
-- EXISTS and the constraint inside a duplicate_object guard. The old backend
-- never reads the new columns (drizzle selects only the columns its schema
-- names) and its inserts get the DEFAULT, so applying this before the deploy
-- is safe.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   ALTER TABLE social_media_channels
--     DROP CONSTRAINT IF EXISTS social_media_channels_nickname_chk,
--     DROP COLUMN IF EXISTS show_in_sidebar,
--     DROP COLUMN IF EXISTS nickname;
--   (every nickname and sidebar pin is lost; channels show account_name)
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

ALTER TABLE "social_media_channels"
  ADD COLUMN IF NOT EXISTS "nickname" varchar(80);

ALTER TABLE "social_media_channels"
  ADD COLUMN IF NOT EXISTS "show_in_sidebar" boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  ALTER TABLE "social_media_channels"
    ADD CONSTRAINT "social_media_channels_nickname_chk"
    CHECK (
      "nickname" IS NULL
      OR char_length(btrim("nickname")) BETWEEN 1 AND 80
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
