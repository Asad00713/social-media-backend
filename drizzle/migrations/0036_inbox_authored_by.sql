-- 0036 — record which teammate composed an outgoing inbox row.
--
-- WHY
-- `inbox_items.replied_by_user_id` already exists, but it means something
-- different: it is stamped on the INCOMING row that was answered ("teammate X
-- dealt with this"). The inbox needs the other direction — who wrote the row
-- we sent — so a shared inbox can show whose reply it was. Every outbound
-- message carries the same platform identity (the page or profile), so
-- without this there is nothing to distinguish one colleague from another.
-- `replied_by_user_id` cannot be reused: it lives on the inbound row, and a
-- new top-level comment answers no inbound row at all.
--
-- SAFETY
-- Additive only: one nullable column plus its FK and a partial index. No
-- rewrite of existing rows (a nullable ADD COLUMN with no DEFAULT is a
-- catalog-only change in PG 11+), no backfill, no data loss by construction.
-- Existing rows keep NULL, which the API already renders as "no teammate
-- attached" for replies made before this shipped.
--
-- ROLLBACK
--   DROP INDEX IF EXISTS inbox_items_authored_by_idx;
--   ALTER TABLE inbox_items DROP COLUMN IF EXISTS authored_by_user_id;
--
-- PROD RUNBOOK
--   1. Apply these statements one at a time.
--   2. ON DELETE SET NULL is deliberate: deleting a user must not delete
--      inbox history. Verify the constraint exists afterwards with
--        SELECT confrelid::regclass, confdeltype FROM pg_constraint
--        WHERE conname = 'inbox_items_authored_by_user_id_fkey';
--      confdeltype should be 'n' (SET NULL).
--   3. Never run `db:push` against prod — it would drop the partial index
--      below, which drizzle-kit does not model.

ALTER TABLE "inbox_items"
  ADD COLUMN IF NOT EXISTS "authored_by_user_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'inbox_items_authored_by_user_id_fkey'
  ) THEN
    ALTER TABLE "inbox_items"
      ADD CONSTRAINT "inbox_items_authored_by_user_id_fkey"
      FOREIGN KEY ("authored_by_user_id") REFERENCES "users"("id")
      ON DELETE SET NULL;
  END IF;
END $$;

-- Partial: only our own rows ever carry an author, and they are the minority
-- of the table, so indexing the NULLs would be dead weight. Supports the
-- per-teammate lookups ("what did X send") this column exists to enable.
CREATE INDEX IF NOT EXISTS "inbox_items_authored_by_idx"
  ON "inbox_items" ("authored_by_user_id")
  WHERE "authored_by_user_id" IS NOT NULL;
