-- 0062 - Insights Audience: the latest audience breakdown of each channel, one
-- row per channel.
--
-- WHY
-- The Insights Audience tab shows where a channel's followers live (top
-- countries and cities), how old they are and their gender. The platforms
-- only give this as a current snapshot, and they gate it (Instagram and
-- Threads need 100 followers, Facebook needs a permission), so a nightly job
-- fetches it and keeps the latest result here; the page reads this table
-- instead of calling the platform on every view. There is no history: each
-- fetch overwrites the row (upsert on channel_id).
--
-- `status` records why a row may be empty: ok, below_threshold (under 100
-- followers, the fetch was not made), no_permission (the platform refused the
-- scope), unsupported (the platform has no such data) or failed (any other
-- error). The four jsonb columns hold the raw platform counts as
-- [{"key": "PK", "value": 120}, ...]; percentages, top-N and bucket merging
-- are computed when the page reads, not stored. follower_count is the count
-- the 100-follower decision was made on (NULL when unknown).
--
-- channel_id is `integer` like the other channel_id foreign keys written by
-- hand (calendar sync, ads); social_media_channels.id is bigserial, and an
-- integer column may reference a bigint one. Deleting the channel deletes its
-- row. fetched_at is timestamptz, deliberately: a bare `timestamp` next to
-- timestamptz columns misreads by the session offset (the mixed-column trap).
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY. New table only: no existing table or row is read, changed or
-- dropped. Idempotent: CREATE TABLE IF NOT EXISTS. The old code never touches
-- the table, so applying this BEFORE (or with) the new code is always safe,
-- and the boot migrator does exactly that. Applying it AFTER the new code is
-- running is tolerated, not clean: the audience read answers 500 and the
-- nightly job fails for every channel until the table exists.
--
-- LOCKS AND COST
-- `SET LOCAL lock_timeout = '10s'` comes first. The foreign key takes a SHARE
-- ROW EXCLUSIVE lock on social_media_channels until COMMIT; without the
-- timeout it would queue behind any open transaction on the still-running old
-- instance, and every write to that table would queue behind it. With it a
-- blocked deploy fails fast and rolls back; retry the deploy. The table is
-- new and empty, and the primary key (channel_id) serves both the read and
-- the channel cascade, so no extra index is needed.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   DROP TABLE IF EXISTS channel_audience;
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS "channel_audience" (
  "channel_id" integer PRIMARY KEY
    REFERENCES "social_media_channels" ("id") ON DELETE CASCADE,
  "status" text NOT NULL,
  "follower_count" integer,
  "countries" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "cities" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "ages" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "genders" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "fetched_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "channel_audience_status_chk"
    CHECK ("status" IN ('ok', 'below_threshold', 'no_permission', 'unsupported', 'failed'))
);
