-- 0099 - Two-step sign-in: TOTP columns, backup codes, sign-in challenges
--        and trusted devices.
--
-- WHY
-- Settings -> Security lets a person turn on two-step sign-in with an
-- authenticator app (spec §7.2). After the password (or Google), a person
-- with it on is asked for a 6-digit code unless the browser was trusted in
-- the last 30 days.
--   users.totp_secret_enc          the active TOTP seed, AES-256-GCM
--                                  (`iv:tag:ct`), read only through the
--                                  strict decrypt. NULL while 2FA is off.
--   users.totp_pending_secret_enc  the seed shown during setup, promoted to
--                                  totp_secret_enc once a code proves it.
--   users.totp_enabled_at          when 2FA was turned on; NULL = off.
--   users.totp_last_step           the last accepted 30 s time step, so the
--                                  same code can never be used twice.
--   users.mfa_failures             consecutive wrong second factors; 10 set
--   users.mfa_locked_until         a 15-minute lock on further attempts.
--   known_devices.mfa_trusted_until  "don't ask again on this browser" for
--                                  30 days after a successful code.
--   user_backup_codes              10 single-use codes, stored only as an
--                                  HMAC-SHA256 under a server pepper.
--   login_challenges               the short-lived step between the password
--                                  and the code ('mfa'), and the super-admin
--                                  emailed-code step ('admin_email'), each
--                                  consumed at most once.
-- Every timestamp is timestamptz, deliberately (the mixed-column trap).
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY. Additive only: nullable columns, one NOT NULL DEFAULT 0
-- column, two new tables. No existing row is read, changed or dropped. The
-- old backend never reads the new columns (drizzle selects only the columns
-- its schema names), so applying this before the deploy is safe.
-- Idempotent: ADD COLUMN / CREATE TABLE / CREATE INDEX IF NOT EXISTS.
--
-- LOCKS AND COST
-- `SET LOCAL lock_timeout = '10s'` comes first. ADD COLUMN takes ACCESS
-- EXCLUSIVE on users and on known_devices until COMMIT; every column here
-- is catalog-only on PostgreSQL 11 and later (nullable with no default, or
-- a constant default), so no table is rewritten and the lock is short. The
-- two new tables' foreign keys take SHARE ROW EXCLUSIVE on users. Without
-- the timeout any of these would queue behind an open transaction on the
-- still-running old instance and every sign-in would queue behind it; with
-- it a blocked deploy fails fast and rolls back. Retry the deploy.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   DROP TABLE IF EXISTS login_challenges;
--   DROP TABLE IF EXISTS user_backup_codes;
--   ALTER TABLE known_devices DROP COLUMN IF EXISTS mfa_trusted_until;
--   ALTER TABLE users
--     DROP COLUMN IF EXISTS mfa_locked_until,
--     DROP COLUMN IF EXISTS mfa_failures,
--     DROP COLUMN IF EXISTS totp_last_step,
--     DROP COLUMN IF EXISTS totp_enabled_at,
--     DROP COLUMN IF EXISTS totp_pending_secret_enc,
--     DROP COLUMN IF EXISTS totp_secret_enc;
-- Dropping these turns every user's two-step sign-in off. Revert the code
-- first, and tell the people who had it on.
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "totp_secret_enc" text;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "totp_pending_secret_enc" text;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "totp_enabled_at" timestamptz;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "totp_last_step" bigint;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "mfa_failures" integer NOT NULL DEFAULT 0;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "mfa_locked_until" timestamptz;

ALTER TABLE "known_devices"
  ADD COLUMN IF NOT EXISTS "mfa_trusted_until" timestamptz;

CREATE TABLE IF NOT EXISTS "user_backup_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL
    REFERENCES "users" ("id") ON DELETE CASCADE,
  "code_hash" char(64) NOT NULL,
  "used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "user_backup_codes_user_unused_idx"
  ON "user_backup_codes" ("user_id")
  WHERE "used_at" IS NULL;

CREATE TABLE IF NOT EXISTS "login_challenges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL
    REFERENCES "users" ("id") ON DELETE CASCADE,
  "purpose" text NOT NULL
    CHECK ("purpose" IN ('mfa', 'admin_email')),
  "attempts" integer NOT NULL DEFAULT 0,
  "device_hash" char(64),
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "login_challenges_user_idx"
  ON "login_challenges" ("user_id");
