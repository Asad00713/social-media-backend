-- 0083 - Platform status: is Instagram (or X, or TikTok...) healthy right now?
--
-- WHY
-- When a network has a bad hour, every customer sees their posts fail or go
-- out late and has no way to tell "my account" from "Instagram". The app now
-- measures each publishing platform's health every two minutes (failure rate
-- of platform-side publish errors, lag of scheduled posts, sync failures,
-- across several workspaces) and shows it on an in-app status page, with a
-- toast when a platform the workspace uses changes state. Three tables:
--   platform_status          one row per platform: the state shown now
--                            (status) and why (reason), the state measured
--                            and why (measured_status, measured_reason, kept
--                            apart so an incident can override them and
--                            ending the incident falls back to them), since
--                            when (since) and the numbers behind the
--                            measurement (signals, for support).
--   platform_status_changes  append-only history of every change of the
--                            shown state; the status page lists 7 days.
--   platform_incidents       incidents a super admin posts by hand. platform
--                            NULL means every platform. While unresolved
--                            (resolved_at NULL) the incident's severity
--                            overrides the measured state of its platform.
-- The index the measurement uses on posts.updated_at is in its own file,
-- 0086_posts_updated_at_index.sql, so a slow build there never rolls these
-- tables back.
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY. Locks, in the order they are taken:
--   1. CREATE TABLE platform_incidents ... REFERENCES users takes SHARE ROW
--      EXCLUSIVE on `users`; writes to users (last_login_at on sign-in) wait
--      until this file commits. `lock_timeout` (10 s) bounds the wait behind
--      the still-running old instance (I4); if it trips, the file rolls back.
-- The three new tables are empty, so their own constraints and indexes are
-- instant. No existing row is written or dropped.
-- Idempotent: CREATE ... IF NOT EXISTS throughout.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   DROP TABLE IF EXISTS platform_status_changes;
--   DROP TABLE IF EXISTS platform_status;
--   DROP TABLE IF EXISTS platform_incidents;
--   (the status history and every incident are lost; the next measurement
--   recreates platform_status)
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS "platform_incidents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "platform" varchar(32),
  "severity" varchar(16) NOT NULL,
  "title" varchar(120) NOT NULL,
  "body" text,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "resolved_at" timestamptz,
  "created_by" uuid
    REFERENCES "users" ("id") ON DELETE SET NULL,
  "updated_by" uuid
    REFERENCES "users" ("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "platform_incidents_platform_chk"
    CHECK ("platform" IS NULL OR "platform" ~ '^[a-z_]{1,32}$'),
  CONSTRAINT "platform_incidents_severity_chk"
    CHECK ("severity" IN ('delayed', 'outage')),
  CONSTRAINT "platform_incidents_title_chk"
    CHECK (char_length(btrim("title")) BETWEEN 1 AND 120),
  CONSTRAINT "platform_incidents_body_chk"
    CHECK ("body" IS NULL OR char_length("body") <= 2000),
  CONSTRAINT "platform_incidents_resolved_chk"
    CHECK ("resolved_at" IS NULL OR "resolved_at" >= "started_at")
);

CREATE INDEX IF NOT EXISTS "platform_incidents_active_idx"
  ON "platform_incidents" ("started_at" DESC)
  WHERE "resolved_at" IS NULL;

CREATE INDEX IF NOT EXISTS "platform_incidents_resolved_idx"
  ON "platform_incidents" ("resolved_at" DESC)
  WHERE "resolved_at" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "platform_status" (
  "platform" varchar(32) PRIMARY KEY,
  "status" varchar(16) NOT NULL,
  "measured_status" varchar(16) NOT NULL,
  "measured_reason" varchar(32),
  "reason" varchar(32),
  "incident_id" uuid
    REFERENCES "platform_incidents" ("id") ON DELETE SET NULL,
  "signals" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "since" timestamptz NOT NULL DEFAULT now(),
  "measured_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "platform_status_platform_chk"
    CHECK ("platform" ~ '^[a-z_]{1,32}$'),
  CONSTRAINT "platform_status_status_chk"
    CHECK ("status" IN ('operational', 'delayed', 'outage')),
  CONSTRAINT "platform_status_measured_status_chk"
    CHECK ("measured_status" IN ('operational', 'delayed', 'outage'))
);

CREATE TABLE IF NOT EXISTS "platform_status_changes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "platform" varchar(32) NOT NULL,
  "from_status" varchar(16) NOT NULL,
  "to_status" varchar(16) NOT NULL,
  "reason" varchar(32),
  "incident_id" uuid
    REFERENCES "platform_incidents" ("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "platform_status_changes_platform_chk"
    CHECK ("platform" ~ '^[a-z_]{1,32}$'),
  CONSTRAINT "platform_status_changes_from_chk"
    CHECK ("from_status" IN ('operational', 'delayed', 'outage')),
  CONSTRAINT "platform_status_changes_to_chk"
    CHECK ("to_status" IN ('operational', 'delayed', 'outage')),
  CONSTRAINT "platform_status_changes_differ_chk"
    CHECK ("from_status" <> "to_status")
);

CREATE INDEX IF NOT EXISTS "platform_status_changes_created_idx"
  ON "platform_status_changes" ("created_at" DESC);
