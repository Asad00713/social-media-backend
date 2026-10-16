-- 0039 — who a person posts for: their own brand, or clients (an agency).
--
-- WHY
-- Onboarding step 1 now asks "Who are you posting for?". The answer changes
-- copy ("Brand name" vs "Client name"), and later the Home cards and where
-- "Add client" shows. It belongs to the person, not a workspace: an agency
-- owns many client workspaces and answers once.
--
-- SAFETY
-- Additive only: a new enum type and one nullable column with no default, a
-- catalog-only change in PG 11+ (no table rewrite). No backfill: users who
-- signed up before the question have no answer, and NULL says exactly that.
-- Idempotent: the type is created in a duplicate_object guard and the column
-- with IF NOT EXISTS, so a re-run is a no-op. Nothing here reads row data, so
-- it cannot fail on what prod happens to contain (see 0038's outage).
--
-- ROLLBACK
--   ALTER TABLE users DROP COLUMN IF EXISTS use_case;
--   DROP TYPE IF EXISTS "public"."user_use_case";
--
-- Never run `db:push` against prod. The boot migrator applies this file.

DO $$
BEGIN
  CREATE TYPE "public"."user_use_case" AS ENUM('own_brand', 'clients');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "use_case" "public"."user_use_case";
