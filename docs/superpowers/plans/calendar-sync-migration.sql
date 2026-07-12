-- =============================================================================
-- Calendar Two-Way Sync — targeted migration (Task A)
-- Hand-written (not `db:generate`) to avoid bundling ~46 files of unrelated
-- schema drift. Creates ONLY the 3 new calendar-sync tables + their FKs,
-- indexes and unique constraints. Mirrors src/drizzle/schema/calendar-sync.schema.ts.
--
-- id types: workspace_id / post_id are uuid (uuid pks); channel_id is integer
-- because social_media_channels.id is a bigserial (numeric) pk.
-- =============================================================================

-- 1. calendar_post_links -------------------------------------------------------
CREATE TABLE IF NOT EXISTS "calendar_post_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "channel_id" integer NOT NULL,
  "provider" varchar(20) NOT NULL,
  "post_id" uuid NOT NULL,
  "external_event_id" varchar(512) NOT NULL,
  "external_calendar_id" varchar(512),
  "etag" varchar(512),
  "last_pushed_hash" varchar(128),
  "last_external_updated_at" timestamp,
  "sync_status" varchar(20) DEFAULT 'synced' NOT NULL,
  "last_error" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "cpl_channel_post_uq" UNIQUE ("channel_id", "post_id")
);

DO $$ BEGIN
  ALTER TABLE "calendar_post_links"
    ADD CONSTRAINT "calendar_post_links_workspace_id_workspace_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "calendar_post_links"
    ADD CONSTRAINT "calendar_post_links_channel_id_social_media_channels_id_fk"
    FOREIGN KEY ("channel_id") REFERENCES "social_media_channels"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "calendar_post_links"
    ADD CONSTRAINT "calendar_post_links_post_id_posts_id_fk"
    FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "cpl_channel_event_ix"
  ON "calendar_post_links" ("channel_id", "external_event_id");

-- 2. external_calendar_events --------------------------------------------------
CREATE TABLE IF NOT EXISTS "external_calendar_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "channel_id" integer NOT NULL,
  "provider" varchar(20) NOT NULL,
  "external_calendar_id" varchar(512),
  "external_event_id" varchar(512) NOT NULL,
  "title" text,
  "starts_at" timestamp,
  "ends_at" timestamp,
  "is_all_day" boolean DEFAULT false NOT NULL,
  "html_link" text,
  "external_updated_at" timestamp,
  "raw" jsonb,
  "fetched_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "ece_channel_event_uq" UNIQUE ("channel_id", "external_event_id")
);

DO $$ BEGIN
  ALTER TABLE "external_calendar_events"
    ADD CONSTRAINT "external_calendar_events_workspace_id_workspace_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "external_calendar_events"
    ADD CONSTRAINT "external_calendar_events_channel_id_social_media_channels_id_fk"
    FOREIGN KEY ("channel_id") REFERENCES "social_media_channels"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "ece_workspace_time_ix"
  ON "external_calendar_events" ("workspace_id", "starts_at");

-- 3. calendar_sync_state -------------------------------------------------------
CREATE TABLE IF NOT EXISTS "calendar_sync_state" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "channel_id" integer NOT NULL,
  "provider" varchar(20) NOT NULL,
  "sync_token" text,
  "delta_link" text,
  "watch_channel_id" varchar(255),
  "watch_resource_id" varchar(512),
  "watch_expiration" timestamp,
  "subscription_id" varchar(255),
  "subscription_expiration" timestamp,
  "last_full_sync_at" timestamp,
  "last_incremental_sync_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "calendar_sync_state_channel_id_unique" UNIQUE ("channel_id")
);

DO $$ BEGIN
  ALTER TABLE "calendar_sync_state"
    ADD CONSTRAINT "calendar_sync_state_channel_id_social_media_channels_id_fk"
    FOREIGN KEY ("channel_id") REFERENCES "social_media_channels"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;
