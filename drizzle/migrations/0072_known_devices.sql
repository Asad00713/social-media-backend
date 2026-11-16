-- 0072 - Known devices: the browsers each person has signed in from.
--
-- WHY
-- The "New sign-in to Schedura" security email (A6) goes out when someone
-- signs in from a device we have not seen before. A device is a browser
-- profile, identified by the `sd_device` cookie (32 random bytes, base64url,
-- HttpOnly, 400 days) that register, login and the Google callback set. Only
-- the sha256 of the cookie is stored (`device_hash`, 64 hex chars), so a
-- database read cannot replay a cookie. User agent strings change with every
-- browser update and the country changes with travel and VPNs, which is why
-- neither is the key.
--
-- One row per (user, device). A known device only moves `last_seen_at`. An
-- unknown device is inserted; if the person already had a row, A6 and the
-- `newLogin` bell are sent. The first device ever is recorded silently, so
-- deploy day sends no flood of A6 and a new user gets no alert for signing up.
-- `label` is the parsed browser and OS ('Chrome on Windows'), never the raw
-- user agent; `country` is the GeoIP country at first sight, or NULL. No IP
-- address is stored. Concurrent sign-ins from one new device insert one row:
-- the application inserts with ON CONFLICT DO NOTHING on the primary key and
-- only the inserting request sends the email.
-- Every timestamp is timestamptz, deliberately: a bare `timestamp` next to
-- timestamptz columns misreads by the session offset (the mixed-column trap).
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY. New table only: no existing table or row is read, changed or
-- dropped. Idempotent: CREATE TABLE IF NOT EXISTS. The old code never touches
-- the table, so applying this BEFORE (or with) the new code is always safe,
-- and the boot migrator does exactly that. Applying it AFTER the new code is
-- running is tolerated, not clean: device tracking fails, is logged and is
-- swallowed, so sign-in keeps working but no A6 is sent until the table
-- exists.
--
-- LOCKS AND COST
-- `SET LOCAL lock_timeout = '10s'` comes first. The foreign key takes a SHARE
-- ROW EXCLUSIVE lock on users until COMMIT; without the timeout it would queue
-- behind any open transaction on the still-running old instance, and every
-- write to users would queue behind it. With it a blocked deploy fails fast
-- and rolls back; retry the deploy. The table is new and empty. The primary
-- key (user_id, device_hash) serves both reads a sign-in makes: the exact
-- device and "does this person have any device".
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   DROP TABLE IF EXISTS known_devices;
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS "known_devices" (
  "user_id" uuid NOT NULL
    REFERENCES "users" ("id") ON DELETE CASCADE,
  "device_hash" char(64) NOT NULL,
  "label" varchar(120) NOT NULL,
  "country" varchar(100),
  "first_seen_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "device_hash")
);
