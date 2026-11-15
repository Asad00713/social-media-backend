-- 0080 - Soft removal of workspace members, so a removal can be undone.
--
-- WHY
-- A member is an ACCEPTED row of workspace_invitations. Removing one used to
-- DELETE the row, so the Team page's "Undo" had nothing to bring back. The
-- row is now kept and marked instead:
--   invitation_status   gains 'REMOVED'.
--   removed_at          when the member was removed (timestamptz).
--   removed_by          who removed them (users.id, SET NULL if that account
--                       is deleted). Equal to user_id for a member who left
--                       on their own; that is never restorable.
-- Every reader of the table filters on status = 'ACCEPTED' (members, roles,
-- access) or 'PENDING' (invitations, seat reservations), so a REMOVED row
-- grants nothing and blocks nothing. Restoring sets it back to ACCEPTED with
-- the same role, within a 15-minute window enforced by the backend.
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY. Locks, in the order they are taken:
--   1. ALTER TYPE ... ADD VALUE locks the enum type only. The new value is
--      not used in this transaction, which Postgres requires.
--   2. ADD COLUMN of a nullable column with no default is catalog-only (no
--      rewrite), but takes ACCESS EXCLUSIVE on workspace_invitations.
--      `lock_timeout` (10 s) bounds the wait behind the still-running old
--      instance (I4); if it trips, the whole file rolls back.
--   3. The foreign key on removed_by takes SHARE ROW EXCLUSIVE on `users`
--      and validates by scanning workspace_invitations (small; the column is
--      NULL on every existing row, so no lookup in users is needed).
-- No existing row is written or dropped. Idempotent: ADD VALUE IF NOT
-- EXISTS, ADD COLUMN IF NOT EXISTS, and the constraint inside a
-- duplicate_object guard. The old backend never reads the new columns
-- (drizzle selects only the columns its schema names) and never writes
-- 'REMOVED', so applying this before the deploy is safe.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   UPDATE workspace_invitations SET status = 'ACCEPTED' ... is NOT a
--   rollback (it would re-admit removed people). To roll back:
--   DELETE FROM workspace_invitations WHERE status = 'REMOVED';
--   ALTER TABLE workspace_invitations
--     DROP COLUMN IF EXISTS removed_by,
--     DROP COLUMN IF EXISTS removed_at;
--   (an enum value cannot be dropped; 'REMOVED' is harmless if left)
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

ALTER TYPE "public"."invitation_status" ADD VALUE IF NOT EXISTS 'REMOVED';

ALTER TABLE "workspace_invitations"
  ADD COLUMN IF NOT EXISTS "removed_at" timestamptz;

ALTER TABLE "workspace_invitations"
  ADD COLUMN IF NOT EXISTS "removed_by" uuid;

DO $$
BEGIN
  ALTER TABLE "workspace_invitations"
    ADD CONSTRAINT "workspace_invitations_removed_by_fkey"
    FOREIGN KEY ("removed_by") REFERENCES "users" ("id")
    ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
