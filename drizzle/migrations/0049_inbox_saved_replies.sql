-- 0049 - inbox_saved_replies: per-workspace canned replies with a /shortcut.
--
-- WHY
-- Agents insert a stored reply by typing its shortcut. Replies are soft-
-- deleted; the shortcut is unique only among live rows so a deleted shortcut
-- can be reused.
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction. Everything is
-- idempotent and non-destructive: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF
-- NOT EXISTS. New table only; no existing table or row is touched. No
-- CONCURRENTLY.
--
-- ROLLBACK
--   DROP TABLE IF EXISTS inbox_saved_replies;
--
-- Never run `db:push` against prod. The boot migrator applies this file.

CREATE TABLE IF NOT EXISTS "inbox_saved_replies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "name" varchar(60) NOT NULL,
  "shortcut" varchar(32) NOT NULL,
  "body" text NOT NULL,
  "usage_count" integer NOT NULL DEFAULT 0,
  "created_by_user_id" uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz,
  CONSTRAINT "inbox_saved_replies_name_chk"
    CHECK (char_length("name") BETWEEN 1 AND 60),
  CONSTRAINT "inbox_saved_replies_shortcut_chk"
    CHECK ("shortcut" ~ '^[a-z0-9-]{1,32}$'),
  CONSTRAINT "inbox_saved_replies_body_chk"
    CHECK (char_length("body") BETWEEN 1 AND 5000)
);

CREATE UNIQUE INDEX IF NOT EXISTS "inbox_saved_replies_shortcut_uq"
  ON "inbox_saved_replies" ("workspace_id", "shortcut")
  WHERE "deleted_at" IS NULL;
