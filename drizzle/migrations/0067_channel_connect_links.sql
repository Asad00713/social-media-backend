-- 0067 - Channel connect links: let a client connect their own accounts.
--
-- WHY
-- A teammate or agency often needs a social account that someone else owns.
-- A "connect link" lets the owner connect it themselves from a public page
-- (/c/<token>) with no Schedura account and no password sharing. Two things
-- must be stored:
--   channel_connect_links   one row per link: who sent it, to whom, which
--                           networks it offers, and the token. Only the
--                           SHA-256 of the token is ever looked up
--                           (token_hash, unique); the raw token is also kept
--                           encrypted (token_encrypted, the reversible
--                           encryption channel tokens use) so the sender can
--                           copy / resend the SAME url for the link's life.
--                           A link is revoked (revoked_at), never deleted;
--                           status (open / expired / revoked) is derived.
--   social_media_channels   three columns that mark a channel as "added
--                           through a link": connect_link_id (which link),
--                           added_via_link_at and added_via_link_email (the
--                           mark itself, copied at connect time so it
--                           survives the link row being removed).
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY. ADD COLUMN of a nullable column is catalog-only (no rewrite),
-- but still takes ACCESS EXCLUSIVE on social_media_channels for the length of
-- this transaction; `lock_timeout` bounds the wait behind the still-running
-- old instance (I4). The new foreign key on social_media_channels is added
-- on a column that is NULL on every existing row, so its
-- validation scan finds nothing to check. channel_connect_links is a brand
-- new empty table, so its constraints and indexes are instant. Its foreign
-- keys take SHARE ROW EXCLUSIVE on workspace and users. No existing row is
-- read, written or dropped. Idempotent: CREATE ... IF NOT EXISTS, ADD COLUMN
-- IF NOT EXISTS, and each added constraint inside a duplicate_object guard.
-- The old backend never reads the new columns (drizzle selects only the
-- columns its schema names), so applying this before the deploy is safe.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   ALTER TABLE social_media_channels
--     DROP COLUMN IF EXISTS added_via_link_email,
--     DROP COLUMN IF EXISTS added_via_link_at,
--     DROP COLUMN IF EXISTS connect_link_id;
--   DROP TABLE IF EXISTS channel_connect_links;
--   (every link and every "added through a link" mark is lost; the channels
--   themselves stay)
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS "channel_connect_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "created_by_user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "email" varchar(320),
  "networks" text[] NOT NULL,
  "token_hash" char(64) NOT NULL,
  "token_encrypted" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "last_sent_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE "channel_connect_links"
    ADD CONSTRAINT "channel_connect_links_token_hash_key"
    UNIQUE ("token_hash");
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "channel_connect_links"
    ADD CONSTRAINT "channel_connect_links_networks_chk"
    CHECK (cardinality("networks") BETWEEN 1 AND 8);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "channel_connect_links_workspace_created_idx"
  ON "channel_connect_links" ("workspace_id", "created_at" DESC);

ALTER TABLE "social_media_channels"
  ADD COLUMN IF NOT EXISTS "connect_link_id" uuid;

ALTER TABLE "social_media_channels"
  ADD COLUMN IF NOT EXISTS "added_via_link_at" timestamptz;

ALTER TABLE "social_media_channels"
  ADD COLUMN IF NOT EXISTS "added_via_link_email" varchar(320);

DO $$
BEGIN
  ALTER TABLE "social_media_channels"
    ADD CONSTRAINT "social_media_channels_connect_link_id_fkey"
    FOREIGN KEY ("connect_link_id") REFERENCES "channel_connect_links" ("id")
    ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
