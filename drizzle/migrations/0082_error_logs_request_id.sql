-- 0082 - error_logs.request_id: find the exact log row behind an error toast.
--
-- WHY
-- Every HTTP request now carries an id (X-Request-Id response header, and a
-- `requestId` field on every error body; src/logs/request-context.ts). An
-- error toast offers "Copy error ID"; the user pastes it to support, and an
-- admin looks the rows up with GET /admin/logs?requestId=. LogWriterService
-- stores the id on every row written while a request runs (the exception
-- filter's row and any logger.error / warn inside the request).
--
-- One nullable column and one b-tree index on error_logs:
--   request_id  varchar(68): 'req_' + up to 64 alphanumerics, or a uuid.
--               NULL for rows written outside a request (queue workers,
--               crons) and for every row from before this migration.
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY. Locks, in order:
--   1. ADD COLUMN (nullable, no default) is catalog-only, under ACCESS
--      EXCLUSIVE on error_logs. `lock_timeout` (10 s) bounds the wait behind
--      the old instance's inserts; if it trips the whole file rolls back.
--   2. CREATE INDEX (not CONCURRENTLY) takes SHARE on error_logs and builds
--      by one scan. Every existing value is NULL. error_logs is pruned by
--      LogRetentionService, so the scan is bounded; inserts from the old
--      instance wait for it (they are fire-and-forget and never block a
--      response).
-- No existing row is written or dropped. The old backend never reads or
-- writes the column (drizzle names only its schema's columns), so applying
-- this before the deploy is safe.
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS error_logs_request_id_idx;
--   ALTER TABLE error_logs DROP COLUMN IF EXISTS request_id;
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

ALTER TABLE "error_logs"
  ADD COLUMN IF NOT EXISTS "request_id" varchar(68);

CREATE INDEX IF NOT EXISTS "error_logs_request_id_idx"
  ON "error_logs" ("request_id");
