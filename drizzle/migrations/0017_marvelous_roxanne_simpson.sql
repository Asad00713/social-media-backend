CREATE TABLE "inbox_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" integer NOT NULL,
	"platform" varchar(20) NOT NULL,
	"type" varchar(10) NOT NULL,
	"platform_item_id" varchar(255) NOT NULL,
	"platform_parent_id" varchar(255),
	"platform_post_id" varchar(255),
	"our_post_id" uuid,
	"author_platform_id" varchar(255),
	"author_handle" varchar(255),
	"author_display_name" varchar(255),
	"author_avatar_url" text,
	"text" text,
	"status" varchar(20) DEFAULT 'unread' NOT NULL,
	"from_me" boolean DEFAULT false NOT NULL,
	"platform_created_at" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replied_by_user_id" uuid,
	"replied_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "unique_inbox_item_per_channel" UNIQUE("channel_id","platform_item_id")
);
--> statement-breakpoint
ALTER TABLE "social_media_channels" ADD COLUMN "refresh_token_issued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "social_media_channels" ADD COLUMN "last_inbox_poll_at" timestamp;--> statement-breakpoint
ALTER TABLE "channel_sync_state" ADD COLUMN "last_posts_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel_sync_state" ADD COLUMN "pubsubhubbub_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_channel_id_social_media_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."social_media_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_our_post_id_posts_id_fk" FOREIGN KEY ("our_post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_replied_by_user_id_users_id_fk" FOREIGN KEY ("replied_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_workspace_idx" ON "inbox_items" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "inbox_workspace_status_idx" ON "inbox_items" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "inbox_channel_idx" ON "inbox_items" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "inbox_post_idx" ON "inbox_items" USING btree ("channel_id","platform_post_id");--> statement-breakpoint
CREATE INDEX "inbox_parent_idx" ON "inbox_items" USING btree ("platform_parent_id");--> statement-breakpoint
CREATE INDEX "inbox_platform_created_idx" ON "inbox_items" USING btree ("platform_created_at");