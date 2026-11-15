-- 0071 - users.pending_email*: change the sign-in email with a code sent to the new address.
--
-- WHY
-- POST /users/me/email-change stores the requested address and the sha256 of
-- a 6-digit code mailed to it (A3); POST /users/me/email-change/confirm
-- switches `email` only when that code comes back, so nobody can move an
-- account onto an address they do not read. Until then the account keeps its
-- old address: the pending one lives in its own columns, never in `email`.
--   pending_email             the normalised new address, NULL = no change open
--   pending_email_code_hash   sha256 hex of the code (64 chars), never the code
--   pending_email_expires_at  now + 10 minutes when the code was issued
--   pending_email_attempts    wrong codes so far; 5 cancels the change
-- The expiry is timestamptz, deliberately: a bare `timestamp` next to
-- timestamptz columns misreads by the session offset (the mixed-column trap).
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY. Four new columns: three nullable with no default, and one
-- NOT NULL DEFAULT 0, which since PostgreSQL 11 is a catalog-only change (the
-- constant default is stored once, not written to every row). No row is read,
-- changed or dropped, and the table is not rewritten. Idempotent: ADD COLUMN
-- IF NOT EXISTS. The old code never reads these columns, so applying this
-- BEFORE (or with) the new code is always safe, and the boot migrator does
-- exactly that. Applying it AFTER the new code is running is NOT tolerated:
-- every full read of `users` selects the columns and answers 500 until they
-- exist.
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
--   ALTER TABLE users
--     DROP COLUMN IF EXISTS pending_email,
--     DROP COLUMN IF EXISTS pending_email_code_hash,
--     DROP COLUMN IF EXISTS pending_email_expires_at,
--     DROP COLUMN IF EXISTS pending_email_attempts;
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "pending_email" varchar(255),
  ADD COLUMN IF NOT EXISTS "pending_email_code_hash" varchar(64),
  ADD COLUMN IF NOT EXISTS "pending_email_expires_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "pending_email_attempts" integer NOT NULL DEFAULT 0;
