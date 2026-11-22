-- 0100 - Two-step sign-in: the account lock escalates.
--
-- WHY
-- 0099's lock caps a burst, not a slow attacker: ten wrong second factors
-- lock the account for 15 minutes and reset the count, so someone who has
-- the password and rotates addresses keeps ~960 TOTP guesses a day forever
-- (final review finding 4). Each lock now lasts longer than the one before:
--   users.mfa_lock_count   locks set since the last correct second factor.
--                          0 -> the next lock is 15 minutes, 1 -> 1 hour,
--                          2 -> 4 hours, 3 or more -> 24 hours.
-- A correct second factor resets it with mfa_failures; turning two-step
-- sign-in off (and an admin reset) resets it too.
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY. Additive only: one NOT NULL DEFAULT 0 column. No existing
-- row is read, changed or dropped. The old backend never reads the new
-- column (drizzle selects only the columns its schema names), so applying
-- this before the deploy is safe. Idempotent: ADD COLUMN IF NOT EXISTS.
--
-- LOCKS AND COST
-- `SET LOCAL lock_timeout = '10s'` comes first. ADD COLUMN takes ACCESS
-- EXCLUSIVE on users until COMMIT; a constant default is catalog-only on
-- PostgreSQL 11 and later, so no table is rewritten and the lock is short.
-- Without the timeout it would queue behind an open transaction on the
-- still-running old instance and every sign-in would queue behind it; with
-- it a blocked deploy fails fast and rolls back. Retry the deploy.
--
-- NUMBERING
-- 0100 was reserved for Settings Part C; it was free on origin/main and on
-- this branch, so Part B takes it and Part C renumbers.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   ALTER TABLE users DROP COLUMN IF EXISTS mfa_lock_count;
-- Revert the code first: the new code names the column on every second
-- factor. Dropping it only forgets how many locks each account has had.
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "mfa_lock_count" integer NOT NULL DEFAULT 0;
