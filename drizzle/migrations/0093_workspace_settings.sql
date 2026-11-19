-- 0093 - Workspace settings columns, and a note on workspace invitations.
--
-- WHY
-- The Settings redesign adds workspace-level settings that live nowhere today:
--   approval_policy        who needs approval before publishing: 'none',
--                          'members' (people with the MEMBER role) or
--                          'everyone'. Existing workspaces keep 'none', which
--                          is how they behave today.
--   shorten_links_default  the composer shortens links by default.
--   utm_default            the composer adds UTM tags by default.
--   invite_link_code       the code in the shareable join link. NULL until an
--                          admin first turns the link on. Unique across all
--                          workspaces (many NULLs are allowed).
--   invite_link_enabled    the link only works while this is true.
-- workspace_invitations gains message, the optional personal note an inviter
-- writes, shown in the invitation email.
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY.
--   1. ADD COLUMN takes ACCESS EXCLUSIVE on workspace and on
--      workspace_invitations. `lock_timeout` (10 s) bounds the wait behind the
--      still-running old instance (I4); if it trips, the whole file rolls back.
--   2. All columns are catalog-only on PostgreSQL 11 and later: each is either
--      nullable with no default or has a constant default, so no table rewrite
--      happens.
--   3. The CHECK constraint is validated against the existing rows. Every row
--      holds the default 'none', which satisfies it, so the scan only reads.
--   4. The unique index is built on a column that is NULL on every existing
--      row. workspace is small, so the build holds its SHARE lock briefly.
-- The old backend never reads the new columns (drizzle selects only the
-- columns its schema names), so applying this before the deploy is safe.
-- Idempotent: ADD COLUMN IF NOT EXISTS, the constraint inside a
-- duplicate_object guard, and CREATE UNIQUE INDEX IF NOT EXISTS.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   DROP INDEX IF EXISTS workspace_invite_link_code_uq;
--   ALTER TABLE workspace
--     DROP CONSTRAINT IF EXISTS workspace_approval_policy_check,
--     DROP COLUMN IF EXISTS invite_link_enabled,
--     DROP COLUMN IF EXISTS invite_link_code,
--     DROP COLUMN IF EXISTS utm_default,
--     DROP COLUMN IF EXISTS shorten_links_default,
--     DROP COLUMN IF EXISTS approval_policy;
--   ALTER TABLE workspace_invitations DROP COLUMN IF EXISTS message;
--   (drops the saved settings and every issued invite link code)
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

ALTER TABLE "workspace"
  ADD COLUMN IF NOT EXISTS "approval_policy" text NOT NULL DEFAULT 'none';

ALTER TABLE "workspace"
  ADD COLUMN IF NOT EXISTS "shorten_links_default" boolean NOT NULL DEFAULT false;

ALTER TABLE "workspace"
  ADD COLUMN IF NOT EXISTS "utm_default" boolean NOT NULL DEFAULT false;

ALTER TABLE "workspace"
  ADD COLUMN IF NOT EXISTS "invite_link_code" varchar(32);

ALTER TABLE "workspace"
  ADD COLUMN IF NOT EXISTS "invite_link_enabled" boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  ALTER TABLE "workspace"
    ADD CONSTRAINT "workspace_approval_policy_check"
    CHECK ("approval_policy" IN ('none', 'members', 'everyone'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_invite_link_code_uq"
  ON "workspace" ("invite_link_code");

ALTER TABLE "workspace_invitations"
  ADD COLUMN IF NOT EXISTS "message" text;
