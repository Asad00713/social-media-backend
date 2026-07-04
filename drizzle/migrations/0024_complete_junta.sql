CREATE TABLE "maestro_channel_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" varchar(16) NOT NULL,
	"external_id" varchar(128) NOT NULL,
	"display_name" text,
	"default_workspace_id" uuid NOT NULL,
	"conversation_id" uuid,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"linked_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maestro_bridge_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "addon_pricing" ADD COLUMN "units_per_quantity" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "scheduled_plan_code" varchar(20);--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "scheduled_change_at" timestamp;--> statement-breakpoint
ALTER TABLE "social_media_channels" ADD COLUMN "telegram_webhook_route_id" text;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD COLUMN "is_hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "maestro_channel_links" ADD CONSTRAINT "maestro_channel_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maestro_channel_links" ADD CONSTRAINT "maestro_channel_links_default_workspace_id_workspace_id_fk" FOREIGN KEY ("default_workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maestro_bridge_threads" ADD CONSTRAINT "maestro_bridge_threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maestro_bridge_threads" ADD CONSTRAINT "maestro_bridge_threads_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "maestro_links_channel_external_uniq" ON "maestro_channel_links" USING btree ("channel","external_id");--> statement-breakpoint
CREATE INDEX "maestro_links_user_idx" ON "maestro_channel_links" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "maestro_bridge_threads_user_ws_uniq" ON "maestro_bridge_threads" USING btree ("user_id","workspace_id");--> statement-breakpoint
ALTER TABLE "social_media_channels" ADD CONSTRAINT "social_media_channels_telegram_webhook_route_id_unique" UNIQUE("telegram_webhook_route_id");