-- 0097 - Validate the foreign keys 0094 and 0095 added NOT VALID.
--
-- WHY
-- 0095 re-points seven foreign keys to users and 0094 gives the label tables
-- their four foreign keys. Both add them NOT VALID: validating inside those
-- files would scan each referencing table while its file holds ACCESS
-- EXCLUSIVE (0095: on users and the referencing table) or SHARE ROW EXCLUSIVE
-- (0094: on posts, workspace and users) until commit, so sign-ins, saves and
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
--      same column before 0095 replaced it (0095's tables), so no violation
--      is expected there; one would fail the boot loudly, naming the
--      constraint, with nothing changed.
--      The LABEL tables are the exception: 0094 adds their keys NOT VALID
--      after its backfill, and the workspace purge may hard-delete a post, a
--      workspace or a label in that gap (nothing yet cascaded to the label
--      rows, because no key existed). Such an orphan would fail the VALIDATE
--      on EVERY boot. So, for a label key that is still NOT VALID, this file
--      first repairs exactly the rows that would fail it, the way the key's
--      own ON DELETE action would have, had it existed:
--        workspace_labels.workspace_id  missing workspace -> DELETE the label
--                                       (its post_labels rows cascade)
--        workspace_labels.created_by    missing user      -> SET NULL
--        post_labels.post_id            missing post      -> DELETE the row
--        post_labels.label_id           missing label     -> DELETE the row
--      Only rows whose referenced row is MISSING are touched; a key that is
--      already valid is skipped, so a second run does nothing. These are
--      plain row locks (ROW EXCLUSIVE), blocking no reader or writer.
--   3. A constraint that is missing (a table created by push that an
--      environment does not have, see 0095) or already valid is skipped.
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
        -- 0095
        ('workspace_invitations', 'workspace_invitations_invited_by_fkey'),
        ('subscription_changes',  'subscription_changes_changed_by_user_id_fkey'),
        ('usage_events',          'usage_events_triggered_by_user_id_fkey'),
        ('drip_posts',            'drip_posts_reviewed_by_id_fkey'),
        ('drip_campaign_history', 'drip_campaign_history_performed_by_id_fkey'),
        ('canva_connections',     'canva_connections_user_id_fkey'),
        ('workspace',             'workspace_owner_id_fkey'),
        -- 0094
        ('workspace_labels',      'workspace_labels_workspace_id_fkey'),
        ('workspace_labels',      'workspace_labels_created_by_fkey'),
        ('post_labels',           'post_labels_post_id_fkey'),
        ('post_labels',           'post_labels_label_id_fkey')
      ) AS t (table_name, constraint_name)
  LOOP
    rel := to_regclass(format('%I', target.table_name));
    IF rel IS NULL THEN
      RAISE NOTICE '0097: table % does not exist, skipped', target.table_name;
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_constraint c
       WHERE c.conrelid = rel
         AND c.conname = target.constraint_name
         AND c.contype = 'f'
         AND NOT c.convalidated
    ) THEN
      -- The label keys only (see SAFETY 2): drop what would fail the scan.
      -- The workspace key runs before the label key, so a label removed for
      -- its missing workspace takes its post_labels rows with it.
      IF target.constraint_name = 'workspace_labels_workspace_id_fkey' THEN
        DELETE FROM workspace_labels l
         WHERE NOT EXISTS (SELECT 1 FROM workspace w WHERE w.id = l.workspace_id);
      ELSIF target.constraint_name = 'workspace_labels_created_by_fkey' THEN
        UPDATE workspace_labels l
           SET created_by = NULL
         WHERE l.created_by IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = l.created_by);
      ELSIF target.constraint_name = 'post_labels_post_id_fkey' THEN
        DELETE FROM post_labels pl
         WHERE NOT EXISTS (SELECT 1 FROM posts p WHERE p.id = pl.post_id);
      ELSIF target.constraint_name = 'post_labels_label_id_fkey' THEN
        DELETE FROM post_labels pl
         WHERE NOT EXISTS (
           SELECT 1 FROM workspace_labels l WHERE l.id = pl.label_id
         );
      END IF;
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I',
                     target.table_name, target.constraint_name);
    END IF;
  END LOOP;
END $$;
