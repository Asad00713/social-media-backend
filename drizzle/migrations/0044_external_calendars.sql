-- 0044 - External calendars: every calendar of a connection, each with its own cursor.
--
-- WHY
-- Until now a Google/Outlook connection synced only its PRIMARY calendar. The
-- Planner shows every calendar the user can see, with a per-calendar toggle and
-- colour, so each calendar gets a row here. A row carries that calendar's own
-- delta cursor (Google sync_token / Graph delta_link) and last full sync, so
-- secondary calendars are pulled independently of the primary one (whose cursor
-- stays on calendar_sync_state). external_calendar_events gains calendar_id (the
-- owning row; NULL for rows imported before this migration, backfilled by the
-- next primary pull) and attendee_count. The new columns are timestamptz; the
-- existing starts_at/ends_at (timestamp WITHOUT time zone) are left alone.
-- An event is now unique per (channel, provider calendar, event id) instead of
-- (channel, event id): Google gives a meeting the same id on every calendar it
-- sits on, and the old key made two calendars share (and delete) one row.
-- external_calendar_id is used rather than calendar_id because legacy rows carry
-- the former while calendar_id is NULL on them (NULLs would allow duplicates).
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction. Everything is
-- idempotent and additive:
--   * CREATE TABLE / CREATE INDEX IF NOT EXISTS; ADD COLUMN IF NOT EXISTS.
--   * Existing rows are not read, changed or dropped (calendar_id is nullable).
--   * The unique key is widened, never narrowed: every row that satisfied
--     (channel_id, external_event_id) satisfies the new key, so it cannot fail.
--
-- ROLLBACK
--   DROP INDEX IF EXISTS ece_calendar_ix;
--   ALTER TABLE external_calendar_events DROP COLUMN IF EXISTS calendar_id;
--   ALTER TABLE external_calendar_events DROP COLUMN IF EXISTS attendee_count;
--   DROP TABLE IF EXISTS external_calendars CASCADE;
--   ALTER TABLE external_calendar_events DROP CONSTRAINT IF EXISTS ece_channel_calendar_event_uq;
--   ALTER TABLE external_calendar_events ADD CONSTRAINT ece_channel_event_uq
--     UNIQUE (channel_id, external_event_id);
--   (the re-add fails if a meeting is now stored once per calendar: delete the
--   extra copies first)
--
-- Never run `db:push` against prod. The boot migrator applies this file.

CREATE TABLE IF NOT EXISTS "external_calendars" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "channel_id" integer NOT NULL REFERENCES "social_media_channels" ("id") ON DELETE CASCADE,
  "provider_calendar_id" varchar(512) NOT NULL,
  "name" text NOT NULL,
  "color" varchar(16),
  "is_primary" boolean NOT NULL DEFAULT false,
  "account_email" text,
  "sync_token" text,
  "delta_link" text,
  "last_full_sync_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "external_calendars_channel_calendar_uq" UNIQUE ("channel_id", "provider_calendar_id")
);

CREATE INDEX IF NOT EXISTS "external_calendars_workspace_ix"
  ON "external_calendars" ("workspace_id");

ALTER TABLE "external_calendar_events"
  ADD COLUMN IF NOT EXISTS "calendar_id" uuid REFERENCES "external_calendars" ("id") ON DELETE CASCADE;

ALTER TABLE "external_calendar_events"
  ADD COLUMN IF NOT EXISTS "attendee_count" integer;

CREATE INDEX IF NOT EXISTS "ece_calendar_ix"
  ON "external_calendar_events" ("calendar_id");

ALTER TABLE "external_calendar_events"
  DROP CONSTRAINT IF EXISTS "ece_channel_event_uq";

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ece_channel_calendar_event_uq'
  ) THEN
    ALTER TABLE "external_calendar_events"
      ADD CONSTRAINT "ece_channel_calendar_event_uq"
      UNIQUE ("channel_id", "external_calendar_id", "external_event_id");
  END IF;
END $$;
