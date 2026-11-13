-- 0064 - Insights Reports: saved analytics reports, one row per report.
--
-- WHY
-- The Insights Reports tab lets a workspace save a report (which channels, which
-- period, which sections), share it as a public link, and have it emailed on a
-- weekly or monthly schedule with an optional PDF. Each saved report is one row
-- here. The report's numbers are NOT stored: they are computed from the live
-- Insights data every time the report is opened, sent or exported.
--
-- channel_ids holds social_media_channels ids but has no foreign key (a Postgres
-- array cannot carry one): the application narrows it to the workspace's
-- existing channels on every read, so a deleted channel simply drops out.
-- period is one of the presets or 'custom'; a custom range needs both dates and
-- spans at most 92 days (custom_to - custom_from <= 91). sections is checked
-- against its allow-list in the DTO, not here. share_token is 32 random bytes,
-- base64url; NULL means the public link is off, and turning it on mints a new
-- token so old links die. opted_out holds lowercased addresses that used the
-- email's "Stop receiving this report" link.
--
-- The schedule is either absent (cadence, weekday and send_minute all NULL), or
-- weekly (weekday and send_minute set), or monthly (send_minute set, weekday
-- NULL). send_minute is minutes after midnight in the workspace time zone, on
-- a 15 minute step. next_run_at is the next send as a UTC instant, recomputed
-- by the application; last_sent_at / last_error record the latest outcome.
-- Every timestamp is timestamptz, deliberately: a bare `timestamp` next to
-- timestamptz columns misreads by the session offset (the mixed-column trap).
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY. New table only: no existing table or row is read, changed or
-- dropped. Idempotent: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS.
-- The old code never touches the table, so applying this BEFORE (or with) the
-- new code is always safe, and the boot migrator does exactly that. Applying it
-- AFTER the new code is running is tolerated, not clean: the Reports routes
-- answer 500 and the send job finds nothing until the table exists.
--
-- LOCKS AND COST
-- `SET LOCAL lock_timeout = '10s'` comes first. The foreign keys take a SHARE
-- ROW EXCLUSIVE lock on workspace, media_items and users until COMMIT; without
-- the timeout they would queue behind any open transaction on the still-running
-- old instance, and every write to those tables would queue behind them. With
-- it a blocked deploy fails fast and rolls back; retry the deploy. The table is
-- new and empty, so the indexes build instantly: the list read uses
-- (workspace_id, created_at DESC), the send job uses the partial index on
-- next_run_at, and share_token's UNIQUE serves the public lookup.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   DROP TABLE IF EXISTS insight_reports;
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS "insight_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL
    REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "channel_ids" integer[] NOT NULL,
  "period" text NOT NULL,
  "custom_from" date,
  "custom_to" date,
  "compare" text NOT NULL,
  "chart_metric" text NOT NULL,
  "sections" text[] NOT NULL,
  "note" text,
  "logo_media_id" uuid
    REFERENCES "media_items" ("id") ON DELETE SET NULL,
  "opted_out" text[] NOT NULL DEFAULT '{}',
  "share_token" text UNIQUE,
  "cadence" text,
  "weekday" smallint,
  "send_minute" smallint,
  "send_to_team" boolean NOT NULL DEFAULT false,
  "recipients" text[] NOT NULL DEFAULT '{}',
  "attach_pdf" boolean NOT NULL DEFAULT true,
  "next_run_at" timestamptz,
  "last_sent_at" timestamptz,
  "last_error" text,
  "created_by" uuid
    REFERENCES "users" ("id") ON DELETE SET NULL,
  "updated_by" uuid
    REFERENCES "users" ("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "insight_reports_name_chk"
    CHECK (char_length("name") BETWEEN 1 AND 80),
  CONSTRAINT "insight_reports_channels_chk"
    CHECK (cardinality("channel_ids") >= 1),
  CONSTRAINT "insight_reports_period_chk"
    CHECK ("period" IN ('last_7_days', 'last_30_days', 'last_month', 'last_quarter', 'custom')),
  CONSTRAINT "insight_reports_custom_chk"
    CHECK ("period" <> 'custom' OR ("custom_from" IS NOT NULL AND "custom_to" IS NOT NULL AND "custom_to" - "custom_from" BETWEEN 0 AND 91)),
  CONSTRAINT "insight_reports_compare_chk"
    CHECK ("compare" IN ('usual', 'previous', 'none')),
  CONSTRAINT "insight_reports_chart_metric_chk"
    CHECK ("chart_metric" IN ('reach', 'views', 'engagements')),
  CONSTRAINT "insight_reports_sections_chk"
    CHECK (cardinality("sections") >= 1),
  CONSTRAINT "insight_reports_note_chk"
    CHECK ("note" IS NULL OR char_length("note") <= 500),
  CONSTRAINT "insight_reports_cadence_chk"
    CHECK ("cadence" IS NULL OR "cadence" IN ('weekly', 'monthly')),
  CONSTRAINT "insight_reports_weekday_chk"
    CHECK ("weekday" IS NULL OR "weekday" BETWEEN 0 AND 6),
  CONSTRAINT "insight_reports_send_minute_chk"
    CHECK ("send_minute" IS NULL OR ("send_minute" BETWEEN 0 AND 1439 AND "send_minute" % 15 = 0)),
  CONSTRAINT "insight_reports_recipients_chk"
    CHECK (cardinality("recipients") <= 10),
  CONSTRAINT "insight_reports_schedule_chk"
    CHECK (
      ("cadence" IS NULL AND "weekday" IS NULL AND "send_minute" IS NULL)
      OR ("cadence" = 'weekly' AND "weekday" IS NOT NULL AND "send_minute" IS NOT NULL)
      OR ("cadence" = 'monthly' AND "weekday" IS NULL AND "send_minute" IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS "insight_reports_workspace_idx"
  ON "insight_reports" ("workspace_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "insight_reports_due_idx"
  ON "insight_reports" ("next_run_at")
  WHERE "cadence" IS NOT NULL;
