CREATE TABLE "telegram_chat_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"telegram_chat_id" varchar(64) NOT NULL,
	"chat_type" varchar(16) NOT NULL,
	"bound_by_telegram_user_id" varchar(64),
	"bound_by_workspace_user_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "onboarding_completed_at" timestamp;--> statement-breakpoint
-- Backfill: existing users who already own a workspace are treated as onboarded.
-- This prevents pre-rollout users from being kicked back through onboarding the
-- first time they land on the new build. Stamps the time of their earliest
-- owned workspace so the column reflects when they actually finished.
UPDATE "users" u
SET "onboarding_completed_at" = w.first_created_at
FROM (
        SELECT "owner_id", MIN("created_at") AS first_created_at
        FROM "workspace"
        GROUP BY "owner_id"
) w
WHERE u."id" = w."owner_id" AND u."onboarding_completed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "telegram_chat_bindings" ADD CONSTRAINT "telegram_chat_bindings_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_chat_bindings" ADD CONSTRAINT "telegram_chat_bindings_bound_by_workspace_user_id_users_id_fk" FOREIGN KEY ("bound_by_workspace_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tg_bindings_workspace_chat_uniq" ON "telegram_chat_bindings" USING btree ("workspace_id","telegram_chat_id");--> statement-breakpoint
CREATE INDEX "tg_bindings_chat_idx" ON "telegram_chat_bindings" USING btree ("telegram_chat_id");