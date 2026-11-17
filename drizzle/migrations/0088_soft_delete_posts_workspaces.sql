-- Soft delete for posts and workspaces.
--
-- Both were hard DELETEs: a post or a workspace removed by mistake was gone,
-- and a workspace took 50 foreign-keyed tables with it — channels, campaigns,
-- inbox, analytics, billing rows — in one cascade, with no undo short of
-- restoring the whole database.
--
-- Rows are now marked instead, and a nightly job purges them after 30 days
-- (the window the media library's recycle bin already uses).
--
-- Idempotent: every statement is IF NOT EXISTS, per docs/migrations.md.

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by_id uuid;

ALTER TABLE workspace
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by_id uuid;

-- Partial indexes: every ordinary read filters `deleted_at IS NULL`, and that
-- is the overwhelming majority of rows, so indexing only the live ones keeps
-- these small. The purge job's own scan is the mirror case.
CREATE INDEX IF NOT EXISTS posts_live_idx
  ON posts (workspace_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS posts_deleted_at_idx
  ON posts (deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS workspace_live_idx
  ON workspace (owner_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS workspace_deleted_at_idx
  ON workspace (deleted_at)
  WHERE deleted_at IS NOT NULL;
