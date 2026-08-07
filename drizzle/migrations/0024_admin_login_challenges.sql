-- Hand-written rather than generated.
--
-- `drizzle-kit generate` on this branch produced a 25-statement migration:
-- because origin/main's journal predates the Canva, calendar, maestro and
-- inbox work, it treated all of those as missing and folded them in alongside
-- this table — including `addon_pricing.units_per_quantity`, a column that has
-- already been added by hand on production. Running that generated file
-- anywhere real would have failed on the first table that already exists.
--
-- This file does one thing instead.

-- The three timestamps are `with time zone` deliberately. A bare `timestamp`
-- compares the digits Node sends (UTC) against Postgres `now()` in the
-- server's own zone, so on any machine not set to UTC every code expires the
-- moment it is written.
CREATE TABLE IF NOT EXISTS "admin_login_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"otp_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"request_ip" varchar(45),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "admin_login_challenges"
		ADD CONSTRAINT "admin_login_challenges_user_id_users_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
		ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_login_challenges_user_created_idx"
	ON "admin_login_challenges" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_login_challenges_expires_idx"
	ON "admin_login_challenges" USING btree ("expires_at");
