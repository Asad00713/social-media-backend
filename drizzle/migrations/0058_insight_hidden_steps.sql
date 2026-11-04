-- 0058 - Insights next steps a person hid: one row per (user, workspace, step).
--
-- WHY
-- The Insights page shows up to three rule-based "Next steps". Each card has
-- a menu: "Not useful" hides that subject for 180 days, "Hide for 30 days"
-- hides it for 30. The choice is personal (a teammate still sees the card)
-- and per workspace, so the row is keyed (user_id, workspace_id, step_id).
-- step_id is the subject the rule gives the card: `format_gap`,
-- `quiet_channel:{channelId}` or `repost_hit:{postId}:{channelId}`. A card is
-- hidden while hidden_until is in the future; expired rows are simply
-- ignored (and overwritten by the next hide of the same subject), nothing
-- deletes them. Deleting the user or the workspace deletes the rows.
--
-- Both timestamps are timestamptz, deliberately: a bare `timestamp` column
-- next to timestamptz ones misreads by the session offset (the mixed-column
-- trap).
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY. New table only: no existing table or row is read, changed or
-- dropped. Idempotent: CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT
-- EXISTS. The running backend never touches the table, so this is safe to
-- apply on start, before or after the code that uses it.
--
-- LOCKS AND COST
-- `SET LOCAL lock_timeout = '10s'` comes first. The two foreign keys take a
-- SHARE ROW EXCLUSIVE lock on users and workspace until COMMIT; without the
-- timeout they would queue behind any open transaction on the still-running
-- old instance, and every write to those tables would queue behind them.
-- With it a blocked deploy fails fast and rolls back; retry the deploy. The
-- table is new and empty, so the index build costs nothing.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   DROP TABLE IF EXISTS insight_hidden_steps;
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS "insight_hidden_steps" (
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "step_id" varchar(120) NOT NULL,
  "hidden_until" timestamptz NOT NULL,
  "reason" varchar(20) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "workspace_id", "step_id"),
  CONSTRAINT "insight_hidden_steps_reason_chk"
    CHECK ("reason" IN ('not_useful', 'later'))
);

-- The primary key serves the per-user read and the user cascade; this serves
-- the workspace cascade.
CREATE INDEX IF NOT EXISTS "insight_hidden_steps_workspace_id_idx"
  ON "insight_hidden_steps" USING btree ("workspace_id");
