-- 0098 - User sessions: one row per sign-in, so it can be listed and revoked.
--
-- WHY
-- Settings -> Security shows "Where you're signed in" and lets a person log
-- out of one device or of every other device (spec §7.1). A JWT cannot be
-- recalled once issued, so every access and refresh token now carries a
-- session id (`sid`) that points at a row here. The row is the authority:
-- a revoked row (`revoked_at` set) or an idle one (`expires_at` passed) makes
-- its tokens stop working within the 30 s session-check cache, and the
-- refresh path refuses them at once.
--
-- Idle expiry: every refresh sets `last_used_at = now()` and
-- `expires_at = now() + 30 days`, so a session ends after 30 days without
-- use. Refresh keeps the same `sid` (no rotation), so two tabs refreshing at
-- once both succeed. `label` is the parsed browser and OS ('Chrome on
-- Windows'), never the raw user agent. `device_hash` is the sha256 of the
-- `sd_device` cookie (as in known_devices), NULL when the request had none.
-- `ip` is kept for the session list's own use and is never sent to the
-- browser; `country` is the GeoIP country, written just after the row.
-- Every timestamp is timestamptz, deliberately (the mixed-column trap).
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY. New table only: no existing table or row is read, changed or
-- dropped. Idempotent: CREATE TABLE / INDEX IF NOT EXISTS. The old code never
-- touches the table, so applying this before the new code is always safe,
-- and the boot migrator does exactly that.
--
-- LOCKS AND COST
-- `SET LOCAL lock_timeout = '10s'` comes first. The foreign key takes a SHARE
-- ROW EXCLUSIVE lock on users until COMMIT; without the timeout it would queue
-- behind any open transaction on the still-running old instance, and every
-- write to users would queue behind it. With it a blocked deploy fails fast
-- and rolls back; retry the deploy. The table is new and empty, so the
-- index builds are instant. The partial index serves the reads the app
-- makes (a user's live sessions) and stays small as revoked rows pile up.
-- The plain (user_id) index serves what the partial one cannot: pruning a
-- user's old revoked/expired rows on each new sign-in, and the ON DELETE
-- CASCADE from users (both would otherwise scan the whole table).
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   DROP TABLE IF EXISTS user_sessions;
-- Safe only after the code that reads it is reverted: the new code refuses a
-- token whose `sid` has no live row.
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS "user_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL
    REFERENCES "users" ("id") ON DELETE CASCADE,
  "device_hash" char(64),
  "label" varchar(120) NOT NULL,
  "device_type" text NOT NULL
    CHECK ("device_type" IN ('desktop', 'mobile', 'tablet', 'unknown')),
  "ip" varchar(45),
  "country" varchar(100),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz
);

CREATE INDEX IF NOT EXISTS "user_sessions_user_live_idx"
  ON "user_sessions" ("user_id")
  WHERE "revoked_at" IS NULL;

CREATE INDEX IF NOT EXISTS "user_sessions_user_idx"
  ON "user_sessions" ("user_id");
