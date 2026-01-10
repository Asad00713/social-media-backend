CREATE TABLE "post_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"action" varchar(50) NOT NULL,
	"previous_status" varchar(50),
	"new_status" varchar(50),
	"channel_id" integer,
	"platform" varchar(50),
	"details" jsonb,
	"performed_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by_id" uuid NOT NULL,
	"content" text,
	"media_items" jsonb DEFAULT '[]'::jsonb,
	"targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(50) DEFAULT 'draft' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"platform_content" jsonb DEFAULT '{}'::jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"last_error" text,
	"retry_count" varchar(10) DEFAULT '0',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "post_history" ADD CONSTRAINT "post_history_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_history" ADD CONSTRAINT "post_history_channel_id_social_media_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."social_media_channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_history" ADD CONSTRAINT "post_history_performed_by_id_users_id_fk" FOREIGN KEY ("performed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_history_post_id_idx" ON "post_history" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "post_history_channel_id_idx" ON "post_history" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "post_history_created_at_idx" ON "post_history" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "posts_workspace_id_idx" ON "posts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "posts_created_by_id_idx" ON "posts" USING btree ("created_by_id");--> statement-breakpoint
CREATE INDEX "posts_status_idx" ON "posts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "posts_scheduled_at_idx" ON "posts" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "posts_created_at_idx" ON "posts" USING btree ("created_at");