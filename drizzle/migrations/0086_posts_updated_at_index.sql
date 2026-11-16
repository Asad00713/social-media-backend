-- 0086 - Index on posts.updated_at for the platform-status measurement.
--
-- WHY
-- Every two minutes the platform-status job reads the composer's "publish
-- now" outcomes, which live only in posts.targets, from the posts updated in
-- the last half hour (src/platform-status/platform-status.repository.ts).
-- No existing index bounds that: created_at misses a draft published days
-- after it was saved, and status / scheduled_at do not apply to a publish
-- now. Without this index the query still answers correctly, by a scan of
-- posts; the index only keeps it cheap as posts grows.
--
-- SAFETY
-- Kept out of 0083 so a slow build here never rolls back the status tables.
-- The boot migrator runs this file in ONE transaction, so it cannot use
-- CONCURRENTLY: CREATE INDEX takes SHARE on `posts` for the whole build, and
-- saving or publishing a post waits for it. Both waits are bounded:
--   lock_timeout 3 s       waiting for the lock behind the old instance;
--   statement_timeout 60 s the build itself.
-- If either trips, this file rolls back and the deploy fails at boot.
--
-- TO AVOID THE LOCK ENTIRELY, pre-create the index from the Railway console
-- before deploying (it does not block writes):
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "posts_updated_at_idx"
--     ON "posts" ("updated_at");
-- This file then finds it and does nothing (IF NOT EXISTS). If a CONCURRENTLY
-- build was interrupted it leaves an INVALID index: DROP INDEX CONCURRENTLY
-- posts_updated_at_idx and build it again first, or this file keeps it as is.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   DROP INDEX IF EXISTS posts_updated_at_idx;
--   (the measurement falls back to a scan of posts)
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE INDEX IF NOT EXISTS "posts_updated_at_idx"
  ON "posts" ("updated_at");
