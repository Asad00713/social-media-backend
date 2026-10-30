-- 0050 - inbox_user_settings: per-user, per-workspace inbox preferences.
--
-- WHY
-- Mark-done-on-reply, the default Later preset, notification level, reply
-- window warnings and AI quick replies are personal, so they key on
-- (user_id, workspace_id). Varchar + CHECK rather than a pg enum, matching
-- the repo pattern from 0042.
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction. Everything is
-- idempotent and non-destructive: CREATE TABLE IF NOT EXISTS. New table only;
-- no existing table or row is touched. No CONCURRENTLY.
--
-- ROLLBACK
--   DROP TABLE IF EXISTS inbox_user_settings;
--
-- Never run `db:push` against prod. The boot migrator applies this file.

CREATE TABLE IF NOT EXISTS "inbox_user_settings" (
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "mark_done_on_reply" boolean NOT NULL DEFAULT true,
  "default_later" varchar(16) NOT NULL DEFAULT 'tomorrow',
  "notify" varchar(24) NOT NULL DEFAULT 'assigned_and_mentions',
  "reply_window_warnings" boolean NOT NULL DEFAULT true,
  "ai_quick_replies" boolean NOT NULL DEFAULT true,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "workspace_id"),
  CONSTRAINT "inbox_user_settings_default_later_chk"
    CHECK ("default_later" IN ('later_today', 'tomorrow', 'next_week')),
  CONSTRAINT "inbox_user_settings_notify_chk"
    CHECK ("notify" IN ('assigned_and_mentions', 'everything', 'nothing'))
);
