CREATE TYPE "public"."ad_entity_status" AS ENUM('ACTIVE', 'PAUSED', 'ARCHIVED', 'DELETED', 'PENDING_REVIEW', 'DISAPPROVED', 'WITH_ISSUES');--> statement-breakpoint
CREATE TYPE "public"."ad_kind" AS ENUM('boost', 'lead_gen');--> statement-breakpoint
CREATE TYPE "public"."ad_objective" AS ENUM('OUTCOME_LEADS', 'OUTCOME_ENGAGEMENT', 'OUTCOME_AWARENESS');--> statement-breakpoint
CREATE TYPE "public"."lead_delivery_status" AS ENUM('pending', 'delivered', 'failed', 'partial');--> statement-breakpoint
CREATE TYPE "public"."lead_route_type" AS ENUM('inbox', 'email', 'webhook');--> statement-breakpoint
CREATE TABLE "ad_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" integer NOT NULL,
	"meta_ad_account_id" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"currency" varchar(8) NOT NULL,
	"timezone_name" varchar(64) NOT NULL,
	"account_status" integer NOT NULL,
	"business_id" varchar(64),
	"disable_reason" integer,
	"capabilities" jsonb DEFAULT '[]'::jsonb,
	"funding_source" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_synced_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "ad_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"channel_id" integer NOT NULL,
	"meta_campaign_id" varchar(64) NOT NULL,
	"name" varchar(400) NOT NULL,
	"objective" "ad_objective" NOT NULL,
	"kind" "ad_kind" NOT NULL,
	"status" "ad_entity_status" NOT NULL,
	"special_ad_categories" jsonb DEFAULT '[]'::jsonb,
	"created_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "ad_kind" NOT NULL,
	"state" jsonb NOT NULL,
	"current_step" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_insights_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"adset_id" uuid NOT NULL,
	"date" varchar(10) NOT NULL,
	"impressions" bigint DEFAULT 0 NOT NULL,
	"reach" bigint DEFAULT 0 NOT NULL,
	"clicks" bigint DEFAULT 0 NOT NULL,
	"spend_minor" bigint DEFAULT 0 NOT NULL,
	"leads_count" bigint DEFAULT 0 NOT NULL,
	"actions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fetched_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"meta_adset_id" varchar(64) NOT NULL,
	"name" varchar(400) NOT NULL,
	"status" "ad_entity_status" NOT NULL,
	"daily_budget_minor" bigint NOT NULL,
	"currency" varchar(8) NOT NULL,
	"start_time" timestamp,
	"end_time" timestamp,
	"optimization_goal" varchar(64) NOT NULL,
	"billing_event" varchar(64) NOT NULL,
	"targeting" jsonb NOT NULL,
	"promoted_object" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"adset_id" uuid NOT NULL,
	"meta_ad_id" varchar(64) NOT NULL,
	"name" varchar(400) NOT NULL,
	"status" "ad_entity_status" NOT NULL,
	"meta_creative_id" varchar(64) NOT NULL,
	"creative_snapshot" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" integer NOT NULL,
	"meta_form_id" varchar(64) NOT NULL,
	"name" varchar(400) NOT NULL,
	"locale" varchar(16) DEFAULT 'en_US' NOT NULL,
	"questions_snapshot" jsonb NOT NULL,
	"privacy_policy_url" text NOT NULL,
	"thank_you_snapshot" jsonb NOT NULL,
	"intro_snapshot" jsonb,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lead_form_id" uuid NOT NULL,
	"type" "lead_route_type" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lead_form_id" uuid NOT NULL,
	"meta_leadgen_id" varchar(64) NOT NULL,
	"meta_ad_id" varchar(64),
	"field_data" jsonb NOT NULL,
	"is_organic" boolean DEFAULT false NOT NULL,
	"captured_at" timestamp NOT NULL,
	"delivery_status" "lead_delivery_status" DEFAULT 'pending' NOT NULL,
	"delivery_attempts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inbox_item_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_channel_id_social_media_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."social_media_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_channel_id_social_media_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."social_media_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_drafts" ADD CONSTRAINT "ad_drafts_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_drafts" ADD CONSTRAINT "ad_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_insights_daily" ADD CONSTRAINT "ad_insights_daily_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_insights_daily" ADD CONSTRAINT "ad_insights_daily_adset_id_ad_sets_id_fk" FOREIGN KEY ("adset_id") REFERENCES "public"."ad_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_sets" ADD CONSTRAINT "ad_sets_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_sets" ADD CONSTRAINT "ad_sets_campaign_id_ad_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ad_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_adset_id_ad_sets_id_fk" FOREIGN KEY ("adset_id") REFERENCES "public"."ad_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_forms" ADD CONSTRAINT "lead_forms_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_forms" ADD CONSTRAINT "lead_forms_channel_id_social_media_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."social_media_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_routes" ADD CONSTRAINT "lead_routes_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_routes" ADD CONSTRAINT "lead_routes_lead_form_id_lead_forms_id_fk" FOREIGN KEY ("lead_form_id") REFERENCES "public"."lead_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_lead_form_id_lead_forms_id_fk" FOREIGN KEY ("lead_form_id") REFERENCES "public"."lead_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_accounts_workspace_idx" ON "ad_accounts" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_accounts_meta_id_uniq" ON "ad_accounts" USING btree ("workspace_id","meta_ad_account_id");--> statement-breakpoint
CREATE INDEX "ad_campaigns_workspace_status_idx" ON "ad_campaigns" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_campaigns_meta_id_uniq" ON "ad_campaigns" USING btree ("ad_account_id","meta_campaign_id");--> statement-breakpoint
CREATE INDEX "ad_drafts_user_idx" ON "ad_drafts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_insights_adset_date_uniq" ON "ad_insights_daily" USING btree ("adset_id","date");--> statement-breakpoint
CREATE INDEX "ad_sets_campaign_idx" ON "ad_sets" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_sets_meta_id_uniq" ON "ad_sets" USING btree ("meta_adset_id");--> statement-breakpoint
CREATE INDEX "ads_adset_idx" ON "ads" USING btree ("adset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ads_meta_id_uniq" ON "ads" USING btree ("meta_ad_id");--> statement-breakpoint
CREATE INDEX "lead_forms_workspace_idx" ON "lead_forms" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_forms_meta_id_uniq" ON "lead_forms" USING btree ("meta_form_id");--> statement-breakpoint
CREATE INDEX "lead_routes_form_idx" ON "lead_routes" USING btree ("lead_form_id");--> statement-breakpoint
CREATE INDEX "leads_workspace_idx" ON "leads" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "leads_form_idx" ON "leads" USING btree ("lead_form_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_meta_id_uniq" ON "leads" USING btree ("meta_leadgen_id");