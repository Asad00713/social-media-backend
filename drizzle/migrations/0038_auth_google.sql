-- 0038 — Google sign-in, and a ceiling on signup-code guesses.
--
-- WHY
-- Sign-up and sign-in gain "Continue with Google". A Google-created account
-- has no password, so `password` must accept NULL; `google_sub` is Google's
-- stable account id and is what a returning Google user is matched by.
--
-- The 6-digit signup code had no attempt limit: a million combinations and
-- ten minutes is brute-forceable. `email_verification_attempts` counts wrong
-- guesses against the current code and is reset whenever a new one is sent.
--
-- SAFETY
-- DROP NOT NULL is catalog-only. ADD COLUMN ... NOT NULL DEFAULT 0 is
-- catalog-only on PG 11+ (no table rewrite). The unique constraint builds an
-- index over a column that is NULL for every existing row, so it is instant.
-- The lower(email) unique index builds over a small table in milliseconds, but
-- FAILS if two rows differ only by case (resolve those by hand first).
-- Every statement is idempotent; re-running the file changes nothing.
--
-- ROLLBACK
--   ALTER TABLE users DROP CONSTRAINT IF EXISTS users_google_sub_unique;
--   ALTER TABLE users DROP COLUMN IF EXISTS google_sub;
--   ALTER TABLE users DROP COLUMN IF EXISTS email_verification_attempts;
--   DROP INDEX IF EXISTS users_email_lower_unique;
--   -- Only if no row has a NULL password (Google users would block it):
--   ALTER TABLE users ALTER COLUMN password SET NOT NULL;
--
-- PROD RUNBOOK
--   1. First run the case-duplicate check from the spec (§6); it must return 0 rows;
--      if it returns rows, resolve them by hand BEFORE applying, because the
--      users_email_lower_unique index below fails on them.
--   2. Apply this file in the Railway console. Never `db:push` prod.

ALTER TABLE "users" ALTER COLUMN "password" DROP NOT NULL;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "email_verification_attempts" integer NOT NULL DEFAULT 0;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "google_sub" varchar(255);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_google_sub_unique'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_google_sub_unique" UNIQUE ("google_sub");
  END IF;
END $$;

-- Case-insensitive email uniqueness. Every lookup matches lower(email), but
-- legacy rows were stored exactly as typed, and the plain UNIQUE on "email" is
-- case-sensitive. This index makes the rollout's case-duplicate check
-- self-enforcing: the statement fails loudly if a case-only duplicate exists,
-- which must then be resolved by hand. It also closes the race where two
-- signups differing only in case both pass the check-then-insert.
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower_unique"
  ON "users" (lower("email"));
