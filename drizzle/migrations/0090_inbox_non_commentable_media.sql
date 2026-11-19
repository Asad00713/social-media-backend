-- 0090 - Remember which media the platform says has no comments edge.
--
-- WHY
-- The inbox poller asks every recent post for comments on every cycle. Meta
-- answers `(#100) nonexisting field (comments)` for a Story, a deleted post,
-- or a media whose edge is not called `comments`. Both the Facebook and
-- Instagram services already catch that and return no comments instead of
-- failing the poll -- but nothing remembered the answer, so the same media was
-- asked again 30 seconds later.
--
-- Measured on production: ONE Instagram Story accounted for 20,169 rows in
-- `error_logs` over seven days. That is 20,169 wasted calls against a
-- rate-limited platform, in a table that reached 738MB once already (0082 and
-- the 7-day retention exist because of that incident).
--
-- A row here is a PERMANENT fact: a Story will never become commentable and a
-- deleted post will not come back. That is why it is a table and not a Redis
-- key with a TTL -- a TTL means relearning the fact, at 20,169 calls, every
-- time the key is evicted.
--
-- It is also why it is not a field on `posts.targets`. Every writer of that
-- jsonb reads the whole array, changes one entry and writes it back; the
-- publish path, the pause/disconnect sweeps and the composer all do. A poller
-- writing there would race them and the loser's write would vanish with no
-- error -- the same read-modify-write bug that silently lost a seat on the
-- usage counters until they moved to a single atomic UPDATE in code.
--
-- SHAPE
-- `(channel_id, platform_post_id)` is both the lookup and the identity. The
-- writer inserts ON CONFLICT DO NOTHING, so two concurrent polls that discover
-- the same Story cannot write it twice. `reason` records which platform error
-- produced the row, so a future reader does not have to guess.
--
-- `platform_post_id` is NOT a foreign key to `posts`: one media can be reached
-- from several post rows, and a post can be hard-deleted while the media still
-- exists on the platform. `channel_id` IS a foreign key, ON DELETE CASCADE --
-- disconnecting a channel makes every row about its media meaningless.
--
-- SAFETY
-- A new table with no rows: CREATE TABLE takes no lock on anything existing,
-- and the two indexes are built on an empty heap. The foreign key takes a
-- brief SHARE ROW EXCLUSIVE on `social_media_channels` (21 rows on
-- production) to validate, which blocks writes to that table for the duration
-- of a scan of 21 rows.
--
-- Both waits are bounded:
--   lock_timeout 3 s        waiting for the lock behind the old instance;
--   statement_timeout 60 s  the statements themselves.
-- If either trips, this file rolls back and the deploy fails at boot.
--
-- Idempotent: every statement is IF NOT EXISTS, per docs/migrations.md.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   DROP TABLE IF EXISTS inbox_non_commentable_media;
--   (the poller's lookup returns nothing and every media is polled again,
--    which is exactly today's behaviour -- no data is lost by dropping it)
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS "inbox_non_commentable_media" (
  "channel_id" bigint NOT NULL
    REFERENCES "social_media_channels"("id") ON DELETE CASCADE,
  "platform_post_id" varchar(255) NOT NULL,
  "reason" varchar(100) NOT NULL,
  "detected_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "inbox_non_commentable_channel_media_idx"
  ON "inbox_non_commentable_media" ("channel_id", "platform_post_id");

CREATE INDEX IF NOT EXISTS "inbox_non_commentable_channel_idx"
  ON "inbox_non_commentable_media" ("channel_id");
