CREATE TABLE "scheduled_inbox_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" integer NOT NULL,
	"type" varchar(10) NOT NULL,
	"thread_key" varchar(255) NOT NULL,
	"parent_item_id" uuid,
	"platform_post_id" varchar(255),
	"conversation_id" varchar(255),
	"target_label" text,
	"text" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"timezone" varchar(64),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"queue_job_id" varchar(255),
	"created_by_user_id" uuid,
	"sent_inbox_item_id" uuid,
	"error_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scheduled_inbox_messages" ADD CONSTRAINT "scheduled_inbox_messages_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_inbox_messages" ADD CONSTRAINT "scheduled_inbox_messages_channel_id_social_media_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."social_media_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_inbox_messages" ADD CONSTRAINT "scheduled_inbox_messages_parent_item_id_inbox_items_id_fk" FOREIGN KEY ("parent_item_id") REFERENCES "public"."inbox_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_inbox_messages" ADD CONSTRAINT "scheduled_inbox_messages_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_inbox_messages" ADD CONSTRAINT "scheduled_inbox_messages_sent_inbox_item_id_inbox_items_id_fk" FOREIGN KEY ("sent_inbox_item_id") REFERENCES "public"."inbox_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduled_inbox_workspace_status_idx" ON "scheduled_inbox_messages" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "scheduled_inbox_channel_status_idx" ON "scheduled_inbox_messages" USING btree ("channel_id","status");--> statement-breakpoint
CREATE INDEX "scheduled_inbox_scheduled_at_idx" ON "scheduled_inbox_messages" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "scheduled_inbox_thread_key_idx" ON "scheduled_inbox_messages" USING btree ("workspace_id","thread_key","status");