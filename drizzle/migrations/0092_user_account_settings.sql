-- 0092 - Account settings columns on users, and the Planner week start copy.
--
-- WHY
-- The Settings redesign gives every person account-level settings that today
-- live nowhere (or per workspace, in the browser):
--   preferences                  jsonb, the Preferences page. Holds only keys
--                                the person has chosen, so '{}' means "all
--                                defaults". Validated by the backend DTO.
--   password_changed_at          when the password last changed (change or
--                                reset), shown on the Security page.
--   notifications_paused_until   "Pause notifications": nothing but failed
--                                posts and security alerts is sent before it.
--   deleted_at                   account soft delete. The row is anonymised in
--                                place rather than removed (see 0095).
-- The Planner week start used to be a per-workspace Planner preference
-- (planner_preferences.prefs ->> 'weekStartsOn', 0 = Sunday, 1 = Monday). It
-- is now one account-wide setting, so the most recently updated value of each
-- user is copied into preferences.weekStart ('sunday' | 'monday') once.
-- planner_preferences is left untouched.
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY.
--   1. ADD COLUMN takes ACCESS EXCLUSIVE on users. `lock_timeout` (10 s)
--      bounds the wait behind the still-running old instance (I4); if it
--      trips, the whole file rolls back.
--   2. All four columns are catalog-only on PostgreSQL 11 and later: three
--      are nullable with no default, and preferences has a constant default
--      ('{}'::jsonb), so no table rewrite happens.
--   3. The copy is one UPDATE that touches only users who have a
--      planner_preferences row carrying weekStartsOn, and only when
--      preferences has no weekStart yet, so a re-run never overwrites a
--      choice the person made afterwards.
-- The old backend never reads the new columns (drizzle selects only the
-- columns its schema names), so applying this before the deploy is safe.
-- Idempotent: ADD COLUMN IF NOT EXISTS, and the copy skips users that already
-- have a weekStart.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   ALTER TABLE users
--     DROP COLUMN IF EXISTS deleted_at,
--     DROP COLUMN IF EXISTS notifications_paused_until,
--     DROP COLUMN IF EXISTS password_changed_at,
--     DROP COLUMN IF EXISTS preferences;
--   (drops the saved preferences; planner_preferences still holds the old
--   week start, so nothing is lost for the Planner)
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "preferences" jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "password_changed_at" timestamptz;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "notifications_paused_until" timestamptz;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "deleted_at" timestamptz;

UPDATE users u SET preferences = u.preferences || jsonb_build_object('weekStart',
  CASE p.week WHEN '0' THEN 'sunday' ELSE 'monday' END)
FROM (SELECT DISTINCT ON (user_id) user_id, prefs->>'weekStartsOn' AS week
        FROM planner_preferences
       WHERE prefs ? 'weekStartsOn'
       ORDER BY user_id, updated_at DESC) p
WHERE p.user_id = u.id AND NOT (u.preferences ? 'weekStart');
