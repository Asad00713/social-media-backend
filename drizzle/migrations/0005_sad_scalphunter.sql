CREATE TABLE "channel_relationships" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"parent_channel_id" integer NOT NULL,
	"child_channel_id" integer NOT NULL,
	"relationship_type" varchar(50) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "unique_channel_relationship" UNIQUE("parent_channel_id","child_channel_id","relationship_type")
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"state_token" varchar(64) NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" varchar(20) NOT NULL,
	"redirect_url" text,
	"code_verifier" varchar(128),
	"additional_data" jsonb,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_states_state_token_unique" UNIQUE("state_token")
);
--> statement-breakpoint
CREATE TABLE "platform_credentials" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"platform" varchar(20) NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text NOT NULL,
	"additional_config" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "platform_credentials_platform_unique" UNIQUE("platform")
);
--> statement-breakpoint
CREATE TABLE "social_media_channels" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"platform" varchar(20) NOT NULL,
	"account_type" varchar(30) NOT NULL,
	"platform_account_id" varchar(255) NOT NULL,
	"account_name" varchar(255) NOT NULL,
	"username" varchar(255),
	"profile_picture_url" text,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"token_expires_at" timestamp,
	"token_scope" text,
	"permissions" jsonb DEFAULT '[]'::jsonb,
	"capabilities" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"connection_status" varchar(20) DEFAULT 'connected' NOT NULL,
	"last_error" text,
	"last_error_at" timestamp,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"last_synced_at" timestamp,
	"last_posted_at" timestamp,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"connected_by_user_id" uuid NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"timezone" varchar(50) DEFAULT 'UTC',
	"color" varchar(7),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "unique_platform_account" UNIQUE("workspace_id","platform","platform_account_id")
);
--> statement-breakpoint
CREATE TABLE "token_refresh_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"channel_id" integer NOT NULL,
	"status" varchar(20) NOT NULL,
	"error_message" text,
	"error_code" varchar(50),
	"old_expires_at" timestamp,
	"new_expires_at" timestamp,
	"request_duration_ms" integer,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_relationships" ADD CONSTRAINT "channel_relationships_parent_channel_id_social_media_channels_id_fk" FOREIGN KEY ("parent_channel_id") REFERENCES "public"."social_media_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_relationships" ADD CONSTRAINT "channel_relationships_child_channel_id_social_media_channels_id_fk" FOREIGN KEY ("child_channel_id") REFERENCES "public"."social_media_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_media_channels" ADD CONSTRAINT "social_media_channels_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_media_channels" ADD CONSTRAINT "social_media_channels_connected_by_user_id_users_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_refresh_logs" ADD CONSTRAINT "token_refresh_logs_channel_id_social_media_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."social_media_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "relationship_parent_idx" ON "channel_relationships" USING btree ("parent_channel_id");--> statement-breakpoint
CREATE INDEX "relationship_child_idx" ON "channel_relationships" USING btree ("child_channel_id");--> statement-breakpoint
CREATE INDEX "oauth_state_token_idx" ON "oauth_states" USING btree ("state_token");--> statement-breakpoint
CREATE INDEX "oauth_expires_idx" ON "oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "channels_workspace_idx" ON "social_media_channels" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "channels_platform_idx" ON "social_media_channels" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "channels_status_idx" ON "social_media_channels" USING btree ("connection_status");--> statement-breakpoint
CREATE INDEX "token_refresh_channel_idx" ON "token_refresh_logs" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "token_refresh_status_idx" ON "token_refresh_logs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "token_refresh_created_idx" ON "token_refresh_logs" USING btree ("created_at");