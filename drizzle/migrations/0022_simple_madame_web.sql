CREATE TABLE "notification_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"channel_id" integer NOT NULL,
	"target_platform_channel_id" varchar(128) NOT NULL,
	"target_display_name" varchar(256),
	"enabled" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_routes" ADD CONSTRAINT "notification_routes_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_routes" ADD CONSTRAINT "notification_routes_channel_id_social_media_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."social_media_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_routes_workspace_idx" ON "notification_routes" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "notification_routes_event_idx" ON "notification_routes" USING btree ("workspace_id","event_type");