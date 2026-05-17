CREATE TABLE "channel_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_id" bigint NOT NULL,
	"snapshot_date" date NOT NULL,
	"followers_count" integer,
	"following_count" integer,
	"total_posts_count" integer,
	"platform_metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metrics_schema_version" integer DEFAULT 1 NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"sync_status" varchar(16) NOT NULL,
	"sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_snapshots_channel_date_unique" UNIQUE("channel_id","snapshot_date")
);
--> statement-breakpoint
CREATE TABLE "post_metric_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"post_id" uuid NOT NULL,
	"channel_id" bigint NOT NULL,
	"snapshot_at" timestamp with time zone NOT NULL,
	"age_bucket" varchar(16) NOT NULL,
	"likes_count" integer,
	"comments_count" integer,
	"shares_count" integer,
	"impressions_count" integer,
	"reach_count" integer,
	"platform_metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metrics_schema_version" integer DEFAULT 1 NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"sync_status" varchar(16) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_analytics_daily" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_id" bigint NOT NULL,
	"date" date NOT NULL,
	"posts_published" integer DEFAULT 0 NOT NULL,
	"total_likes" integer DEFAULT 0 NOT NULL,
	"total_comments" integer DEFAULT 0 NOT NULL,
	"total_shares" integer DEFAULT 0 NOT NULL,
	"total_impressions" integer,
	"total_reach" integer,
	"followers_at_end_of_day" integer,
	"followers_gained" integer,
	"engagement_rate" numeric(5, 2),
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "channel_analytics_daily_channel_date_unique" UNIQUE("channel_id","date")
);
--> statement-breakpoint
CREATE TABLE "channel_sync_state" (
	"channel_id" bigint PRIMARY KEY NOT NULL,
	"last_profile_sync_at" timestamp with time zone,
	"last_profile_sync_status" varchar(20),
	"last_profile_sync_error" text,
	"next_profile_sync_at" timestamp with time zone NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"paused_until" timestamp with time zone,
	"initial_backfill_status" varchar(20) DEFAULT 'pending' NOT NULL,
	"initial_backfill_completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "preferred_ai_provider" varchar(20);--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "reply_to_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "feedback" varchar(10);--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "feedback_comment" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "is_pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "shared_with_workspace" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "shared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel_snapshots" ADD CONSTRAINT "channel_snapshots_channel_id_social_media_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."social_media_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_metric_snapshots" ADD CONSTRAINT "post_metric_snapshots_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_metric_snapshots" ADD CONSTRAINT "post_metric_snapshots_channel_id_social_media_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."social_media_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_analytics_daily" ADD CONSTRAINT "channel_analytics_daily_channel_id_social_media_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."social_media_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_sync_state" ADD CONSTRAINT "channel_sync_state_channel_id_social_media_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."social_media_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_snapshots_channel_date_idx" ON "channel_snapshots" USING btree ("channel_id","snapshot_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "post_metric_snapshots_post_snapshot_idx" ON "post_metric_snapshots" USING btree ("post_id","snapshot_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "post_metric_snapshots_channel_snapshot_idx" ON "post_metric_snapshots" USING btree ("channel_id","snapshot_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "channel_analytics_daily_channel_date_idx" ON "channel_analytics_daily" USING btree ("channel_id","date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "conversations_shared_idx" ON "conversations" USING btree ("workspace_id","shared_with_workspace");