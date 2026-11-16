-- 0073 - users.email_changed_at: when the sign-in email last changed.
--
-- WHY
-- A4 (sent to the OLD address after an email change) carries a 7-day link
-- that switches the email back. A second change made inside those 7 days
-- would defeat it: the link only reverts while the account is still on the
-- address it was sent about. So POST /users/me/email-change answers 409
-- EMAIL_CHANGE_LOCKED until 7 days have passed since the last change. This
-- column is that clock. It is set by a confirmed change and by a revert.
--   email_changed_at   NULL = never changed (or changed before this column)
-- timestamptz, deliberately: a bare `timestamp` next to timestamptz columns
-- misreads by the session offset (the mixed-column trap).
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY. One nullable column with no default: a catalog-only change.
-- No row is read, changed or dropped, and the table is not rewritten.
-- Idempotent: ADD COLUMN IF NOT EXISTS. The old code never reads this column,
-- so applying it BEFORE (or with) the new code is always safe, and the boot
-- migrator does exactly that. Applying it AFTER the new code is running is
-- NOT tolerated: every full read of `users` selects the column and answers
-- 500 until it exists.
--
-- LOCKS AND COST
-- `SET LOCAL lock_timeout = '10s'` comes first. ADD COLUMN takes an ACCESS
-- EXCLUSIVE lock on users for an instant (a catalog change only); without the
-- timeout it would queue behind any open transaction on the still-running old
-- instance, and every read of users, every sign-in, would queue behind it.
-- With it a blocked deploy fails fast and rolls back; retry the deploy.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   ALTER TABLE users DROP COLUMN IF EXISTS email_changed_at;
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "email_changed_at" timestamptz;
