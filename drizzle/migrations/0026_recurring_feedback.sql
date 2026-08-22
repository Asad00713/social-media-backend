-- Hand-written rather than generated, for the same reason as 0025 and 0024:
-- the tracked journal/snapshot chain predates most shipped work, so a fresh
-- `drizzle-kit generate` folds dozens of existing tables into the output.
--
-- Recurring feedback: a user reviews each type repeatedly, so the unique
-- (user_id, type) index becomes a plain ordered index, and dismissals move
-- from browser localStorage into a real table.

DROP INDEX IF EXISTS "feedback_user_id_type_idx";
--> statement-breakpoint
CREATE INDEX "feedback_user_id_type_idx" ON "feedback" USING btree ("user_id","type","created_at" DESC);
--> statement-breakpoint
CREATE TABLE "feedback_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "feedback_type" NOT NULL,
	"dismissed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feedback_dismissals" ADD CONSTRAINT "feedback_dismissals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_dismissals_user_type_uq" ON "feedback_dismissals" USING btree ("user_id","type");
