-- 0037 — per-workspace weekly posting goal for the Home "Posting goal" ring.
--
-- WHY
-- Home shows "published this week / goal". The goal has to live somewhere the
-- whole team shares, so it is a workspace column rather than a user setting.
--
-- SAFETY
-- Additive only: one NOT NULL column with a constant DEFAULT. In PG 11+ that
-- is a catalog-only change (no table rewrite); existing workspaces read 5.
-- The CHECK keeps the value inside the range the API accepts.
--
-- ROLLBACK
--   ALTER TABLE workspace DROP CONSTRAINT IF EXISTS workspace_weekly_post_goal_range;
--   ALTER TABLE workspace DROP COLUMN IF EXISTS weekly_post_goal;
--
-- PROD RUNBOOK
--   1. Apply these statements one at a time (the journal stops at 0026; this
--      file is applied by hand like 0027–0036).
--   2. Verify: SELECT weekly_post_goal FROM workspace LIMIT 1;  -- returns 5

ALTER TABLE "workspace"
  ADD COLUMN IF NOT EXISTS "weekly_post_goal" integer NOT NULL DEFAULT 5;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspace_weekly_post_goal_range'
  ) THEN
    ALTER TABLE "workspace"
      ADD CONSTRAINT "workspace_weekly_post_goal_range"
      CHECK ("weekly_post_goal" BETWEEN 1 AND 100);
  END IF;
END $$;
