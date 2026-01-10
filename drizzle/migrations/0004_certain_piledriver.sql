ALTER TABLE "users" ALTER COLUMN "id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "workspace" ALTER COLUMN "id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "workspace" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "workspace" ALTER COLUMN "owner_id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "stripe_customers" ALTER COLUMN "user_id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "subscription_changes" ALTER COLUMN "changed_by_user_id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "subscriptions" ALTER COLUMN "workspace_id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "workspace_id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "resource_id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "triggered_by_user_id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "workspace_usage" ALTER COLUMN "workspace_id" SET DATA TYPE uuid;