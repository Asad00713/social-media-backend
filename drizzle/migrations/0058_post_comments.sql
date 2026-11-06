-- 0058 - Team comments on a post: the composer's "Comments" row.
--
-- WHY
-- The composer's Post section has a "Comments" row (Figma, All-channels
-- inspector) for a team to discuss a draft before it goes out. A jsonb array
-- on posts.metadata was ruled out: the composer rewrites metadata wholesale
-- on every save, so two people commenting while a third saves would lose
-- comments. One row per comment instead:
--   post_id      the post (cascade: a deleted post takes its thread with it)
--   workspace_id the tenant, so every read is scoped without a join
--   user_id      the author; SET NULL keeps the thread readable when a user
--                is deleted
--   body         1..2000 characters (CHECK)
--   created_at   when it was written
--   resolved_at  when someone marked it resolved; NULL while open
-- The thread is read by post, oldest first: one index on (post_id,
-- created_at).
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY. New table only: no existing table is altered, no row is
-- read, written or dropped. The foreign keys take a SHARE ROW EXCLUSIVE lock
-- on posts, workspace and users for the length of this transaction (they are
-- validated against an empty table, so it is instant); `lock_timeout` bounds
-- the wait behind the still-running old instance (I4). Idempotent: CREATE
-- TABLE / INDEX IF NOT EXISTS and the CHECK inside a duplicate_object guard.
-- The old backend never reads this table, so applying it before the deploy
-- is safe; the new backend answers an empty thread if it is missing.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   DROP TABLE IF EXISTS post_comments;
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS "post_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "post_id" uuid NOT NULL REFERENCES "posts" ("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "user_id" uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  "body" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "resolved_at" timestamptz
);

CREATE INDEX IF NOT EXISTS "post_comments_post_id_created_at_idx"
  ON "post_comments" ("post_id", "created_at");

DO $$
BEGIN
  ALTER TABLE "post_comments"
    ADD CONSTRAINT "post_comments_body_len_chk"
    CHECK (char_length("body") BETWEEN 1 AND 2000);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
