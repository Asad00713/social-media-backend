-- ============================================================================
-- Evergreen Recycling — manual migration (run on Railway prod psql console)
-- ----------------------------------------------------------------------------
-- WHY MANUAL: this repo's drizzle migration journal has pre-existing drift
-- (0024_admin_login_challenges.sql is on disk with no journal entry), so
-- `npm run db:generate` produces a bloated migration that re-creates ~15
-- existing tables without IF NOT EXISTS. Per repo precedent (commit 2cf7946),
-- evergreen's 3 tables are applied by hand-written idempotent SQL instead.
--
-- SAFE TO RE-RUN: every statement is IF NOT EXISTS / guarded, so running this
-- twice does nothing the second time — no data loss, no errors on re-run.
--
-- HOW TO RUN (Railway):
--   Railway dashboard → your Postgres service → "Connect" / "Data" → open a
--   psql console (bash → `psql $DATABASE_URL`, db = railway), then paste this
--   whole file and press Enter. Wrapped in a transaction so it's all-or-nothing.
--
-- Mirrors src/drizzle/schema/evergreen.schema.ts exactly (types, defaults,
-- NOT NULLs, FKs with ON DELETE CASCADE, unique + secondary indexes).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. campaign_evergreen_categories — a bucket with its own schedule + rotation
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaign_evergreen_categories (
  id               uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      uuid           NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name             varchar(120)   NOT NULL,
  color            varchar(20)    NOT NULL,
  schedule         jsonb          NOT NULL,
  channel_ids      jsonb          NOT NULL DEFAULT '[]'::jsonb,
  seasonal         jsonb,
  is_active        boolean        NOT NULL DEFAULT true,
  rotation_cursor  integer        NOT NULL DEFAULT 0,
  sort_order       integer        NOT NULL DEFAULT 0,
  created_at       timestamptz    NOT NULL DEFAULT now(),
  updated_at       timestamptz    NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS evergreen_categories_campaign_name_uq
  ON campaign_evergreen_categories (campaign_id, name);

-- ----------------------------------------------------------------------------
-- 2. campaign_evergreen_posts — a pool member (belongs to one category)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaign_evergreen_posts (
  id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id        uuid          NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  category_id        uuid          NOT NULL REFERENCES campaign_evergreen_categories(id) ON DELETE CASCADE,
  content            jsonb         NOT NULL,
  variations         jsonb         NOT NULL DEFAULT '[]'::jsonb,
  recycle_policy     jsonb         NOT NULL,
  min_gap_hours      integer       NOT NULL DEFAULT 0,
  recycled_count     integer       NOT NULL DEFAULT 0,
  last_published_at  timestamptz,
  performance_score  real,
  is_stale           boolean       NOT NULL DEFAULT false,
  stale_reason       text,
  status             varchar(20)   NOT NULL DEFAULT 'active',
  created_at         timestamptz   NOT NULL DEFAULT now(),
  updated_at         timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS evergreen_posts_category_status_idx
  ON campaign_evergreen_posts (category_id, status);
CREATE INDEX IF NOT EXISTS evergreen_posts_campaign_idx
  ON campaign_evergreen_posts (campaign_id);

-- ----------------------------------------------------------------------------
-- 3. campaign_evergreen_occurrences — append-only fire log → real posts row
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaign_evergreen_occurrences (
  id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    uuid          NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  category_id    uuid          NOT NULL REFERENCES campaign_evergreen_categories(id) ON DELETE CASCADE,
  post_id_ref    uuid          NOT NULL REFERENCES campaign_evergreen_posts(id) ON DELETE CASCADE,
  variation_id   varchar(64),
  channel_id     varchar(255)  NOT NULL,
  scheduled_at   timestamptz   NOT NULL,
  slot_status    varchar(20)   NOT NULL DEFAULT 'scheduled',
  posts_row_id   uuid,
  job_id         varchar(160),
  published_at   timestamptz,
  last_error     text,
  created_at     timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS evergreen_occurrences_campaign_scheduled_idx
  ON campaign_evergreen_occurrences (campaign_id, scheduled_at);
CREATE INDEX IF NOT EXISTS evergreen_occurrences_post_ref_idx
  ON campaign_evergreen_occurrences (post_id_ref);
CREATE INDEX IF NOT EXISTS evergreen_occurrences_job_idx
  ON campaign_evergreen_occurrences (job_id);

COMMIT;

-- ============================================================================
-- Verify (optional) — after COMMIT, run this to confirm all 3 tables exist:
--
--   SELECT table_name
--   FROM information_schema.tables
--   WHERE table_name LIKE 'campaign_evergreen_%'
--   ORDER BY table_name;
--
-- Expect 3 rows:
--   campaign_evergreen_categories
--   campaign_evergreen_occurrences
--   campaign_evergreen_posts
-- ============================================================================
