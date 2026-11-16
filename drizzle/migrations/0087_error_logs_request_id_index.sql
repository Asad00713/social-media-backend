-- 0087 - Index on error_logs.request_id for GET /admin/logs?requestId=.
--
-- WHY
-- An admin looks up the rows of one request by the id a user copied from an
-- error toast ("Copy error ID"). 0082 added the column; this file indexes it.
-- Partial (WHERE request_id IS NOT NULL): only rows written inside an HTTP
-- request carry an id, so queue and cron rows never enter the index, and the
-- `request_id = $1` lookup still uses it.
--
-- SAFETY
-- Kept out of 0082 so that file's ACCESS EXCLUSIVE lock is released at once.
-- The boot migrator runs this file in ONE transaction, so it cannot use
-- CONCURRENTLY: CREATE INDEX takes SHARE on `error_logs` for the whole build,
-- which blocks inserts (the fire-and-forget log writes) but not reads. Every
-- existing row has request_id NULL (0082 just added it), so the build is one
-- heap scan that inserts and sorts nothing. Both waits are bounded:
--   lock_timeout 3 s       waiting for the lock behind the old instance;
--   statement_timeout 60 s the build itself.
-- If either trips, this file rolls back and the deploy fails at boot.
--
-- TO AVOID THE LOCK ENTIRELY, pre-create the index from the Railway console
-- after 0082 is applied and before this file runs (it does not block writes):
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "error_logs_request_id_idx"
--     ON "error_logs" ("request_id") WHERE "request_id" IS NOT NULL;
-- This file then finds it and does nothing (IF NOT EXISTS). If a CONCURRENTLY
-- build was interrupted it leaves an INVALID index: DROP INDEX CONCURRENTLY
-- error_logs_request_id_idx and build it again first, or this file keeps it
-- as is.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   DROP INDEX IF EXISTS error_logs_request_id_idx;
--   (the requestId filter falls back to a scan of error_logs)
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE INDEX IF NOT EXISTS "error_logs_request_id_idx"
  ON "error_logs" ("request_id")
  WHERE "request_id" IS NOT NULL;
