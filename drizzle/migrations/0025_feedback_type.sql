-- Hand-written rather than generated.
--
-- `drizzle-kit generate` on this branch produces a 40+ statement migration
-- for the same reason documented in 0024_admin_login_challenges.sql: the
-- tracked journal/snapshot chain predates the Canva, calendar, maestro,
-- inbox, campaigns, admin_login_challenges and user-region work, so a fresh
-- generate treats all of those already-shipped tables/columns as missing and
-- folds them in alongside this change -- including `addon_pricing.units_per_quantity`,
-- which has already been added by hand on production. Running that generated
-- file anywhere real would fail on the first object that already exists.
--
-- This file does one thing instead: add the `feedback.type` discriminator
-- (see feedback.schema.ts) and its unique (user_id, type) index.

CREATE TYPE "public"."feedback_type" AS ENUM('app', 'maestro');
--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "type" "feedback_type" DEFAULT 'app' NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_user_id_type_idx" ON "feedback" USING btree ("user_id","type");
