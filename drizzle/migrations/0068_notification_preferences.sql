-- 0068 - Notification preferences: per-user, per-workspace channel overrides.
--
-- WHY
-- Email notifications and in-app bells are now switched per event and per
-- channel (email | app) by each member, per workspace. A row here is an
-- OVERRIDE of the catalogue default (src/notification-preferences/
-- notification-events.ts): a missing row means "use the default", so only the
-- switches a person actually flipped are stored.
--
-- workspace_id is NULL only for account-level events (inactivity reminders),
-- which belong to the person, not to a workspace. `event` has no CHECK on
-- purpose: the DTO validates it against the catalogue, so adding an event
-- needs no migration. `channel` is checked ('email' | 'app').
--
-- Uniqueness is two PARTIAL unique indexes, one for workspace rows and one for
-- account rows. They stand in for UNIQUE NULLS NOT DISTINCT, which needs
-- Postgres 15 (the prod version is unconfirmed). A plain UNIQUE would let two
-- NULL-workspace rows coexist, because NULL <> NULL.
-- Every timestamp is timestamptz, deliberately: a bare `timestamp` next to
-- timestamptz columns misreads by the session offset (the mixed-column trap).
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY. New table only: no existing table or row is read, changed or
-- dropped. Idempotent: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS.
-- The old code never touches the table, so applying this BEFORE (or with) the
-- new code is always safe, and the boot migrator does exactly that. Applying it
-- AFTER the new code is running is tolerated, not clean: the preferences routes
-- answer 500 until the table exists.
--
-- LOCKS AND COST
-- `SET LOCAL lock_timeout = '10s'` comes first. The foreign keys take a SHARE
-- ROW EXCLUSIVE lock on users and workspace until COMMIT; without the timeout
-- they would queue behind any open transaction on the still-running old
-- instance, and every write to those tables would queue behind them. With it a
-- blocked deploy fails fast and rolls back; retry the deploy. The table is new
-- and empty, so the indexes build instantly. The (user_id) index serves the
-- per-user read that every send decision makes.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   DROP TABLE IF EXISTS notification_preferences;
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS "notification_preferences" (
  "user_id" uuid NOT NULL
    REFERENCES "users" ("id") ON DELETE CASCADE,
  "workspace_id" uuid
    REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "event" varchar(40) NOT NULL,
  "channel" varchar(8) NOT NULL,
  "enabled" boolean NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "notification_preferences_channel_chk"
    CHECK ("channel" IN ('email', 'app'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "notification_preferences_ws_uq"
  ON "notification_preferences" ("user_id", "workspace_id", "event", "channel")
  WHERE "workspace_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "notification_preferences_account_uq"
  ON "notification_preferences" ("user_id", "event", "channel")
  WHERE "workspace_id" IS NULL;

CREATE INDEX IF NOT EXISTS "notification_preferences_user_idx"
  ON "notification_preferences" ("user_id");
