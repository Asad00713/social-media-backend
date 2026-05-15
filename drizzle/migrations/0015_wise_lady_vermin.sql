CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant', 'system', 'tool');--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'user_inactive_15_days' BEFORE 'system_announcement';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'user_inactive_25_days' BEFORE 'system_announcement';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'user_deactivated_30_days' BEFORE 'system_announcement';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'user_deleted_365_days' BEFORE 'system_announcement';--> statement-breakpoint
CREATE TABLE "ai_usage_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"operation" varchar(50) NOT NULL,
	"tokens_used" integer NOT NULL,
	"platform" varchar(30),
	"input_summary" text,
	"output_length" integer,
	"success" boolean DEFAULT true NOT NULL,
	"error_message" text,
	"api_input_tokens" integer,
	"api_output_tokens" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"type" varchar(50) NOT NULL,
	"color" varchar(20),
	"icon" varchar(50),
	"display_order" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"uploaded_by_id" uuid NOT NULL,
	"category_id" uuid,
	"type" varchar(50) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"file_url" text NOT NULL,
	"thumbnail_url" text,
	"mime_type" varchar(100),
	"file_size" bigint,
	"width" integer,
	"height" integer,
	"duration" integer,
	"cloudinary_public_id" varchar(255),
	"cloudinary_asset_id" varchar(255),
	"tags" jsonb DEFAULT '[]'::jsonb,
	"is_starred" boolean DEFAULT false,
	"usage_count" integer DEFAULT 0,
	"last_used_at" timestamp with time zone,
	"is_deleted" boolean DEFAULT false,
	"deleted_at" timestamp with time zone,
	"deleted_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by_id" uuid NOT NULL,
	"category_id" uuid,
	"name" varchar(255) NOT NULL,
	"description" text,
	"template_type" varchar(50) DEFAULT 'post' NOT NULL,
	"platforms" jsonb DEFAULT '[]'::jsonb,
	"content" jsonb NOT NULL,
	"thumbnail_url" text,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"is_starred" boolean DEFAULT false,
	"usage_count" integer DEFAULT 0,
	"last_used_at" timestamp with time zone,
	"is_deleted" boolean DEFAULT false,
	"deleted_at" timestamp with time zone,
	"deleted_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by_id" uuid NOT NULL,
	"category_id" uuid,
	"name" varchar(255) NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"preview_title" varchar(500),
	"preview_description" text,
	"preview_image_url" text,
	"preview_site_name" varchar(255),
	"tags" jsonb DEFAULT '[]'::jsonb,
	"is_starred" boolean DEFAULT false,
	"usage_count" integer DEFAULT 0,
	"last_used_at" timestamp with time zone,
	"is_deleted" boolean DEFAULT false,
	"deleted_at" timestamp with time zone,
	"deleted_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "text_snippets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by_id" uuid NOT NULL,
	"category_id" uuid,
	"name" varchar(255) NOT NULL,
	"snippet_type" varchar(50) DEFAULT 'caption' NOT NULL,
	"content" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"is_starred" boolean DEFAULT false,
	"usage_count" integer DEFAULT 0,
	"last_used_at" timestamp with time zone,
	"is_deleted" boolean DEFAULT false,
	"deleted_at" timestamp with time zone,
	"deleted_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text,
	"metadata" jsonb,
	"model_used" varchar(100),
	"token_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspended_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspended_reason" varchar(50);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspended_by_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspension_note" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_login_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "inactivity_email_15_days_sent_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "inactivity_email_25_days_sent_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "inactivity_email_30_days_sent_at" timestamp;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "suspended_at" timestamp;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "suspended_reason" varchar(50);--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "suspended_by_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "suspension_note" text;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "ai_tokens_per_month" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_usage" ADD COLUMN "ai_tokens_used_this_month" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_usage" ADD COLUMN "ai_tokens_limit" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_usage" ADD COLUMN "extra_ai_tokens_purchased" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_usage" ADD COLUMN "ai_tokens_reset_date" timestamp;--> statement-breakpoint
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_categories" ADD CONSTRAINT "media_categories_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_uploaded_by_id_users_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_category_id_media_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."media_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_deleted_by_id_users_id_fk" FOREIGN KEY ("deleted_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_templates" ADD CONSTRAINT "media_templates_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_templates" ADD CONSTRAINT "media_templates_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_templates" ADD CONSTRAINT "media_templates_category_id_media_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."media_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_templates" ADD CONSTRAINT "media_templates_deleted_by_id_users_id_fk" FOREIGN KEY ("deleted_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_links" ADD CONSTRAINT "saved_links_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_links" ADD CONSTRAINT "saved_links_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_links" ADD CONSTRAINT "saved_links_category_id_media_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."media_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_links" ADD CONSTRAINT "saved_links_deleted_by_id_users_id_fk" FOREIGN KEY ("deleted_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_snippets" ADD CONSTRAINT "text_snippets_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_snippets" ADD CONSTRAINT "text_snippets_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_snippets" ADD CONSTRAINT "text_snippets_category_id_media_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."media_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_snippets" ADD CONSTRAINT "text_snippets_deleted_by_id_users_id_fk" FOREIGN KEY ("deleted_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_categories_workspace_id_idx" ON "media_categories" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "media_categories_type_idx" ON "media_categories" USING btree ("type");--> statement-breakpoint
CREATE INDEX "media_categories_workspace_type_idx" ON "media_categories" USING btree ("workspace_id","type");--> statement-breakpoint
CREATE INDEX "media_items_workspace_id_idx" ON "media_items" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "media_items_category_id_idx" ON "media_items" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "media_items_type_idx" ON "media_items" USING btree ("type");--> statement-breakpoint
CREATE INDEX "media_items_uploaded_by_id_idx" ON "media_items" USING btree ("uploaded_by_id");--> statement-breakpoint
CREATE INDEX "media_items_is_deleted_idx" ON "media_items" USING btree ("is_deleted");--> statement-breakpoint
CREATE INDEX "media_items_is_starred_idx" ON "media_items" USING btree ("is_starred");--> statement-breakpoint
CREATE INDEX "media_items_created_at_idx" ON "media_items" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "media_items_workspace_type_idx" ON "media_items" USING btree ("workspace_id","type");--> statement-breakpoint
CREATE INDEX "media_items_workspace_deleted_idx" ON "media_items" USING btree ("workspace_id","is_deleted");--> statement-breakpoint
CREATE INDEX "media_templates_workspace_id_idx" ON "media_templates" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "media_templates_category_id_idx" ON "media_templates" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "media_templates_template_type_idx" ON "media_templates" USING btree ("template_type");--> statement-breakpoint
CREATE INDEX "media_templates_created_by_id_idx" ON "media_templates" USING btree ("created_by_id");--> statement-breakpoint
CREATE INDEX "media_templates_is_deleted_idx" ON "media_templates" USING btree ("is_deleted");--> statement-breakpoint
CREATE INDEX "media_templates_created_at_idx" ON "media_templates" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "saved_links_workspace_id_idx" ON "saved_links" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "saved_links_category_id_idx" ON "saved_links" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "saved_links_created_by_id_idx" ON "saved_links" USING btree ("created_by_id");--> statement-breakpoint
CREATE INDEX "saved_links_is_deleted_idx" ON "saved_links" USING btree ("is_deleted");--> statement-breakpoint
CREATE INDEX "saved_links_created_at_idx" ON "saved_links" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "text_snippets_workspace_id_idx" ON "text_snippets" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "text_snippets_category_id_idx" ON "text_snippets" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "text_snippets_snippet_type_idx" ON "text_snippets" USING btree ("snippet_type");--> statement-breakpoint
CREATE INDEX "text_snippets_created_by_id_idx" ON "text_snippets" USING btree ("created_by_id");--> statement-breakpoint
CREATE INDEX "text_snippets_is_deleted_idx" ON "text_snippets" USING btree ("is_deleted");--> statement-breakpoint
CREATE INDEX "text_snippets_created_at_idx" ON "text_snippets" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "chat_messages_conversation_id_idx" ON "chat_messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "chat_messages_created_at_idx" ON "chat_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "conversations_user_id_idx" ON "conversations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "conversations_workspace_id_idx" ON "conversations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "conversations_created_at_idx" ON "conversations" USING btree ("created_at");