-- 0043 - Planner preferences: one row per (user, workspace).
--
-- WHY
-- Each person tunes their own Planner view: post size, colour-by, which
-- layers show, week start, visible external calendars, best-time hints. The
-- settings are personal (not shared like day notes) and per workspace, so the
-- row is keyed (user_id, workspace_id). `prefs` is a sparse JSON document:
-- only keys the user changed are stored and the API fills defaults, so new
-- preferences need no migration. Deleting the user or the workspace deletes
-- the row.
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction. Everything is
-- idempotent and non-destructive:
--   * CREATE TABLE IF NOT EXISTS (primary key declared inline).
--   * New table only: no existing table or row is read, changed or dropped.
--
-- ROLLBACK
--   DROP TABLE IF EXISTS planner_preferences;
--
-- Never run `db:push` against prod. The boot migrator applies this file.

CREATE TABLE IF NOT EXISTS "planner_preferences" (
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "prefs" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "workspace_id")
);
