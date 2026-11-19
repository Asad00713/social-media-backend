-- 0098 - Validate the foreign keys 0092 and 0093 added NOT VALID.
--
-- WHY
-- 0093 re-points seven foreign keys to users and 0092 gives the label tables
-- their four foreign keys. Both add them NOT VALID: validating inside those
-- files would scan each referencing table while its file holds ACCESS
-- EXCLUSIVE (0093: on users and the referencing table) or SHARE ROW EXCLUSIVE
-- (0092: on posts, workspace and users) until commit, so sign-ins, saves and
-- publishes would wait for the scans. A NOT VALID constraint already checks
-- every new and updated row; this file proves the rows that were there
-- before, so the constraints end up exactly as if added valid.
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction of its own; no
-- BEGIN/COMMIT, no CONCURRENTLY.
--   1. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE on the referencing
--      table and ROW SHARE on the referenced one. Neither blocks a reader or
--      a writer (INSERT, UPDATE, DELETE all run alongside); only DDL and
--      VACUUM on the same table wait. `lock_timeout` (10 s) bounds the wait
--      for those locks behind DDL; if it trips, the file rolls back, the
--      constraints stay NOT VALID (still enforced for new rows) and the next
--      boot tries again.
--   2. Each scan only reads. The rows already satisfied a constraint on the
--      same column before 0093 replaced it (0093's tables), or were written
--      by 0092's backfill from rows that exist (the label tables), so no
--      violation is expected; one would fail the boot loudly, naming the
--      constraint, with nothing changed.
--   3. A constraint that is missing (a table created by push that an
--      environment does not have, see 0093) or already valid is skipped.
-- Idempotent: a second run finds every constraint valid and does nothing.
--
-- PROD AUDIT (run before deploy, read-only, to size the scans):
--   SELECT c.conrelid::regclass AS tbl, c.conname, c.convalidated,
--          s.n_live_tup
--     FROM pg_constraint c
--     JOIN pg_stat_user_tables s ON s.relid = c.conrelid
--    WHERE c.contype = 'f'
--      AND c.conname IN (... the eleven names below ...)
--    ORDER BY s.n_live_tup DESC;
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   Nothing to undo: validating changes no row and no behaviour. To go back
--   to NOT VALID, drop and re-add the constraint NOT VALID.
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

DO $$
DECLARE
  target record;
  rel regclass;
BEGIN
  FOR target IN
    SELECT *
      FROM (VALUES
        -- 0093
        ('workspace_invitations', 'workspace_invitations_invited_by_fkey'),
        ('subscription_changes',  'subscription_changes_changed_by_user_id_fkey'),
        ('usage_events',          'usage_events_triggered_by_user_id_fkey'),
        ('drip_posts',            'drip_posts_reviewed_by_id_fkey'),
        ('drip_campaign_history', 'drip_campaign_history_performed_by_id_fkey'),
        ('canva_connections',     'canva_connections_user_id_fkey'),
        ('workspace',             'workspace_owner_id_fkey'),
        -- 0092
        ('workspace_labels',      'workspace_labels_workspace_id_fkey'),
        ('workspace_labels',      'workspace_labels_created_by_fkey'),
        ('post_labels',           'post_labels_post_id_fkey'),
        ('post_labels',           'post_labels_label_id_fkey')
      ) AS t (table_name, constraint_name)
  LOOP
    rel := to_regclass(format('%I', target.table_name));
    IF rel IS NULL THEN
      RAISE NOTICE '0098: table % does not exist, skipped', target.table_name;
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_constraint c
       WHERE c.conrelid = rel
         AND c.conname = target.constraint_name
         AND c.contype = 'f'
         AND NOT c.convalidated
    ) THEN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I',
                     target.table_name, target.constraint_name);
    END IF;
  END LOOP;
END $$;
