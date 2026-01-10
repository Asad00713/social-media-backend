CREATE TABLE "drip_campaign_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"drip_campaign_id" uuid NOT NULL,
	"drip_post_id" uuid,
	"action" varchar(50) NOT NULL,
	"previous_status" varchar(20),
	"new_status" varchar(20),
	"performed_by_id" uuid,
	"performed_by_system" boolean DEFAULT false NOT NULL,
	"details" jsonb,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drip_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"ai_enabled" boolean DEFAULT true NOT NULL,
	"niche" varchar(255) NOT NULL,
	"additional_prompt" text,
	"tone" varchar(50) DEFAULT 'professional',
	"language" varchar(10) DEFAULT 'en',
	"target_channel_ids" jsonb NOT NULL,
	"occurrence_type" varchar(20) NOT NULL,
	"publish_time" time NOT NULL,
	"timezone" varchar(50) DEFAULT 'UTC' NOT NULL,
	"weekly_days" jsonb DEFAULT '[]'::jsonb,
	"custom_interval_days" integer,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"ai_generation_lead_time" integer DEFAULT 60 NOT NULL,
	"email_notification_lead_time" integer DEFAULT 30 NOT NULL,
	"auto_approve" boolean DEFAULT false NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"total_occurrences" integer DEFAULT 0 NOT NULL,
	"completed_occurrences" integer DEFAULT 0 NOT NULL,
	"failed_occurrences" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_error_at" timestamp,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"max_consecutive_errors" integer DEFAULT 3 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"activated_at" timestamp,
	"paused_at" timestamp,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "drip_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"drip_campaign_id" uuid NOT NULL,
	"occurrence_number" integer NOT NULL,
	"scheduled_date" date NOT NULL,
	"scheduled_time" time NOT NULL,
	"scheduled_at" timestamp NOT NULL,
	"ai_generation_at" timestamp NOT NULL,
	"email_notification_at" timestamp NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"generated_content" text,
	"platform_content" jsonb DEFAULT '{}'::jsonb,
	"search_results" jsonb,
	"post_id" uuid,
	"ai_generation_job_id" varchar(100),
	"email_notification_job_id" varchar(100),
	"publish_job_id" varchar(100),
	"reviewed_at" timestamp,
	"reviewed_by_id" uuid,
	"user_edits" jsonb,
	"last_error" text,
	"last_error_at" timestamp,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"max_retries" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"generated_at" timestamp,
	"published_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "posts" ALTER COLUMN "retry_count" SET DATA TYPE varchar(10);--> statement-breakpoint
ALTER TABLE "posts" ALTER COLUMN "retry_count" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "drip_campaign_history" ADD CONSTRAINT "drip_campaign_history_drip_campaign_id_drip_campaigns_id_fk" FOREIGN KEY ("drip_campaign_id") REFERENCES "public"."drip_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drip_campaign_history" ADD CONSTRAINT "drip_campaign_history_drip_post_id_drip_posts_id_fk" FOREIGN KEY ("drip_post_id") REFERENCES "public"."drip_posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drip_campaign_history" ADD CONSTRAINT "drip_campaign_history_performed_by_id_users_id_fk" FOREIGN KEY ("performed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drip_campaigns" ADD CONSTRAINT "drip_campaigns_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drip_campaigns" ADD CONSTRAINT "drip_campaigns_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drip_posts" ADD CONSTRAINT "drip_posts_drip_campaign_id_drip_campaigns_id_fk" FOREIGN KEY ("drip_campaign_id") REFERENCES "public"."drip_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drip_posts" ADD CONSTRAINT "drip_posts_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drip_posts" ADD CONSTRAINT "drip_posts_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;