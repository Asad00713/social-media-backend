-- 0040 - Home "first week": a brand profile per workspace, and AI tokens for Free.
--
-- WHY
-- A new workspace lands on Home with its first week already drafted. A
-- background job reads the user's published posts, writes a one-line brand
-- profile, and drafts five posts. That run needs somewhere to keep its state
-- (workspace_brand_profiles) and the tokens to pay for it. Free had 0 AI
-- tokens, and AiTokenService refuses any plan with 0, so Free gets 100 a month
-- (a first week costs about 33: brand 8 + 5 drafts x 5).
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction, and a failing migration
-- crash-loops prod, so everything here is idempotent and non-destructive:
--   * CREATE TABLE IF NOT EXISTS; the CHECK constraints are added inside a
--     duplicate_object guard, so a re-run is a no-op.
--   * The two UPDATEs carry their own guard (still at zero), so they touch
--     only rows that need it and a re-run changes nothing.
--   * Nothing is dropped or deleted, and nothing reads data in a way that can
--     fail on what prod happens to contain (see 0038 and 0030).
--
-- ROLLBACK
--   DROP TABLE IF EXISTS workspace_brand_profiles;
--   (the Free allowance is data; lower it by hand if it must be reverted)
--
-- Never run `db:push` against prod. The boot migrator applies this file.

CREATE TABLE IF NOT EXISTS "workspace_brand_profiles" (
  "workspace_id" uuid PRIMARY KEY REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "sells" text,
  "voice" text[] NOT NULL DEFAULT '{}',
  "audience" text,
  "source" text NOT NULL,
  "source_channel_id" bigint REFERENCES "social_media_channels" ("id") ON DELETE SET NULL,
  "source_platform" text,
  "posts_read" integer NOT NULL DEFAULT 0,
  "status" text NOT NULL,
  "drafted_count" integer NOT NULL DEFAULT 0,
  "week_starts_on" date,
  "week_ends_at" timestamptz,
  "error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE "workspace_brand_profiles"
    ADD CONSTRAINT "workspace_brand_profiles_status_chk"
    CHECK ("status" IN ('reading', 'drafting', 'ready', 'needs_description', 'no_tokens', 'failed'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "workspace_brand_profiles"
    ADD CONSTRAINT "workspace_brand_profiles_source_chk"
    CHECK ("source" IN ('posts', 'described'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Free plan: 100 AI tokens a month. Guarded by "still at zero" so a plan an
-- operator already edited is left alone.
UPDATE "plans"
SET "ai_tokens_per_month" = 100,
    "features" = jsonb_set(COALESCE("features", '{}'::jsonb), '{aiFeatures}', 'true'::jsonb, true),
    "updated_at" = now()
WHERE "code" = 'FREE' AND "ai_tokens_per_month" = 0;

-- Existing Free workspaces carry their own copy of the limit. Raise only those
-- still at zero whose owner is on Free.
UPDATE "workspace_usage" AS wu
SET "ai_tokens_limit" = 100,
    "updated_at" = now()
FROM "workspace" AS w
JOIN "subscriptions" AS s ON s."user_id" = w."owner_id"
WHERE wu."workspace_id" = w."id"
  AND s."plan_code" = 'FREE'
  AND wu."ai_tokens_limit" = 0;
