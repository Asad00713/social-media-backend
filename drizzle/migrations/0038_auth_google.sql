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
-- Every statement is idempotent; re-running the file changes nothing.
--
-- ROLLBACK
--   ALTER TABLE users DROP CONSTRAINT IF EXISTS users_google_sub_unique;
--   ALTER TABLE users DROP COLUMN IF EXISTS google_sub;
--   ALTER TABLE users DROP COLUMN IF EXISTS email_verification_attempts;
--   -- Only if no row has a NULL password (Google users would block it):
--   ALTER TABLE users ALTER COLUMN password SET NOT NULL;
--
-- PROD RUNBOOK
--   Applied automatically at boot by src/drizzle/migrate (one transaction).
--
-- NOTE — no lower(email) unique index here. It was in the first version of
-- this file and crash-looped the 2026-10-10 deploy: prod holds a case-only
-- duplicate email, the index could not build, the transaction rolled back and
-- the API never came up. The file was never applied anywhere, so it is edited
-- rather than superseded. The index comes back in a later migration that
-- resolves the duplicates first.

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
