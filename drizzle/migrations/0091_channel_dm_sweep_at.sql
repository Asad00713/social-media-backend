-- 0091 - Remember when a channel last swept every DM conversation.
--
-- WHY
-- The DM poller fetched every listed conversation on every cycle. For
-- Instagram that is TWO calls per conversation (a thread-id lookup, then the
-- messages edge), every 30 seconds, whether or not anything had changed.
--
-- Measured on production: ONE conversation produced 2,115 rows in
-- `error_logs` over seven days, every one of them
--   403 {"message":"Application request limit reached","type":"OAuthException"}
-- The top three conversations on channel 101 accounted for ~4,500 rows. The
-- loop fed the limit it was dying on: poll -> 403 -> log -> poll again in 30s.
--
-- The conversation list already carries the last message time, so a quiet
-- conversation can simply not be fetched. What it could NOT do is prove the
-- platform always advances that timestamp -- and an inbox that silently drops
-- a customer's message is far worse than a wasted API call. So a quiet
-- conversation is still swept once an hour, and this column is that clock.
--
-- SHAPE
-- Nullable with no default: NULL means "never swept", which the selector
-- treats as a sweep being due, so every existing channel sweeps once on its
-- first poll after deploy and then settles into the hourly rhythm. That is
-- deliberately the safe direction -- a wrong value here costs one extra pass,
-- never a missed message.
--
-- SAFETY
-- ADD COLUMN with no default and no NOT NULL: Postgres records this in the
-- catalog only. It does NOT rewrite the table and does not scan existing
-- rows, so the ACCESS EXCLUSIVE lock is held for the duration of a catalog
-- update, not a table scan. `social_media_channels` holds 21 rows on
-- production in any case.
--
-- Both waits are bounded:
--   lock_timeout 3 s        waiting for the lock behind the old instance;
--   statement_timeout 60 s  the statement itself.
-- If either trips, this file rolls back and the deploy fails at boot.
--
-- Idempotent: IF NOT EXISTS, per docs/migrations.md.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   ALTER TABLE social_media_channels DROP COLUMN IF EXISTS last_dm_sweep_at;
--   (every conversation is fetched every cycle again -- today's behaviour,
--    no data is lost by dropping it)

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE "social_media_channels"
  ADD COLUMN IF NOT EXISTS "last_dm_sweep_at" timestamp;
