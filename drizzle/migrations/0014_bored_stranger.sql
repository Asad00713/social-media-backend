CREATE TYPE "public"."notification_priority" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('email_verified', 'password_changed', 'new_login', 'workspace_invitation', 'invitation_accepted', 'invitation_rejected', 'member_removed', 'payment_successful', 'payment_failed', 'subscription_expiring', 'plan_changed', 'channel_connected', 'channel_disconnected', 'token_expired', 'post_published', 'post_failed', 'post_scheduled_reminder', 'campaign_started', 'campaign_completed', 'campaign_post_failed', 'new_user_registered', 'new_feedback_submitted', 'system_announcement');--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"title" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"priority" "notification_priority" DEFAULT 'medium' NOT NULL,
	"metadata" jsonb,
	"action_url" text,
	"is_read" boolean DEFAULT false NOT NULL,
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;