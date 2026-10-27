-- 0045 - GIN index on posts.targets for exact (channelId, platformPostId) lookups.
--
-- WHY
-- InboxService.findOurPostId resolves a webhook's platform post id to our post
-- by containment (`targets @> '[{"channelId":..,"platformPostId":..}]'`). It
-- used to scan the first 50 posts of the channel in JS, so older posts were
-- missed and every webhook paid for a wide scan. With this index the exact
-- lookup is index-assisted. jsonb_path_ops is the compact opclass that serves
-- the @> operator, which is the only operator used.
--
-- SAFETY
-- Additive and idempotent (CREATE INDEX IF NOT EXISTS); no rows are read,
-- changed or dropped. A plain CREATE INDEX takes a write lock on `posts` for
-- the duration of the build (seconds at current size); reads are not blocked.
-- CONCURRENTLY is impossible here because the boot migrator runs every file
-- inside one transaction.
--
-- ROLLBACK
--   DROP INDEX IF EXISTS posts_targets_gin_idx;
--
-- Never run `db:push` against prod. The boot migrator applies this file.

CREATE INDEX IF NOT EXISTS "posts_targets_gin_idx"
  ON "posts" USING gin ("targets" jsonb_path_ops);
