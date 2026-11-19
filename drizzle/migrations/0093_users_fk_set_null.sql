-- 0093 - Foreign keys to users stop blocking (or cascading) a user delete.
--
-- WHY
-- Deleting an account (Settings redesign, spec 5.10) must never be blocked
-- by a row that only records who did something, and must never take a
-- workspace with it. Six foreign keys to users were ON DELETE NO ACTION, so
-- any user who had ever invited someone, changed a plan, reviewed a drip post
-- or connected Canva could not be deleted at all; and workspace.owner_id was
-- ON DELETE CASCADE, so deleting an owner silently deleted their workspaces
-- with every channel and post in them. After this file:
--   workspace_invitations.invited_by        SET NULL (column becomes NULLable;
--                                           the invitation is kept)
--   subscription_changes.changed_by_user_id SET NULL (the history is kept)
--   usage_events.triggered_by_user_id       SET NULL (the history is kept)
--   drip_posts.reviewed_by_id               SET NULL
--   drip_campaign_history.performed_by_id   SET NULL (the history is kept)
--   canva_connections.user_id               CASCADE  (it is the person's own
--                                           Canva OAuth grant, and the column
--                                           is NOT NULL, so SET NULL is not
--                                           possible)
--   workspace.owner_id                      RESTRICT (a workspace owner can
--                                           never be deleted by accident; the
--                                           account-delete flow transfers or
--                                           deletes the workspace first)
-- The file ends with a guard that fails if ANY foreign key to users is still
-- NO ACTION, so a table this list missed fails the boot loudly instead of
-- blocking account deletes in production.
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY.
--   1. Constraint names differ between environments (Drizzle-generated vs
--      hand-written vs pushed), so none is hard-coded: for each column the
--      DO block finds every foreign key from that column to users in
--      pg_constraint, drops it, and adds `<table>_<column>_fkey` with the new
--      action. A table that does not exist (canva_connections has no
--      migration in this repo; it was created by push) is skipped.
--   2. DROP CONSTRAINT takes ACCESS EXCLUSIVE on the referencing table and on
--      users; every lock is held until commit. `lock_timeout` (10 s) bounds
--      each wait behind the still-running old instance (I4); if it trips, the
--      whole file rolls back and nothing changes. Sign-ins (which write
--      users.last_login_at) wait for this file; it only touches catalog rows
--      plus one validation scan per table.
--   3. Each new constraint is added NOT VALID, then validated. The rows
--      already satisfied the old constraint on the same column, so the scan
--      only reads. All seven tables are small.
--   4. DROP NOT NULL on workspace_invitations.invited_by is catalog-only.
-- No row is written or deleted. Idempotent: running the file again drops
-- and re-adds the same constraints.
-- Behaviour change on the running backend, intended: a hard delete of a
-- workspace owner (DELETE /users/:id, or the disabled inactivity purge) now
-- fails with 23001 instead of deleting their workspaces. Deleting anyone
-- else now succeeds where it used to fail on a NO ACTION row.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   ALTER TABLE workspace
--     DROP CONSTRAINT IF EXISTS workspace_owner_id_fkey,
--     ADD CONSTRAINT workspace_owner_id_fkey FOREIGN KEY (owner_id)
--       REFERENCES users (id) ON DELETE CASCADE;
--   ALTER TABLE canva_connections
--     DROP CONSTRAINT IF EXISTS canva_connections_user_id_fkey,
--     ADD CONSTRAINT canva_connections_user_id_fkey FOREIGN KEY (user_id)
--       REFERENCES users (id);
--   ALTER TABLE drip_campaign_history
--     DROP CONSTRAINT IF EXISTS drip_campaign_history_performed_by_id_fkey,
--     ADD CONSTRAINT drip_campaign_history_performed_by_id_fkey
--       FOREIGN KEY (performed_by_id) REFERENCES users (id);
--   ALTER TABLE drip_posts
--     DROP CONSTRAINT IF EXISTS drip_posts_reviewed_by_id_fkey,
--     ADD CONSTRAINT drip_posts_reviewed_by_id_fkey
--       FOREIGN KEY (reviewed_by_id) REFERENCES users (id);
--   ALTER TABLE usage_events
--     DROP CONSTRAINT IF EXISTS usage_events_triggered_by_user_id_fkey,
--     ADD CONSTRAINT usage_events_triggered_by_user_id_fkey
--       FOREIGN KEY (triggered_by_user_id) REFERENCES users (id);
--   ALTER TABLE subscription_changes
--     DROP CONSTRAINT IF EXISTS subscription_changes_changed_by_user_id_fkey,
--     ADD CONSTRAINT subscription_changes_changed_by_user_id_fkey
--       FOREIGN KEY (changed_by_user_id) REFERENCES users (id);
--   ALTER TABLE workspace_invitations
--     DROP CONSTRAINT IF EXISTS workspace_invitations_invited_by_fkey,
--     ADD CONSTRAINT workspace_invitations_invited_by_fkey
--       FOREIGN KEY (invited_by) REFERENCES users (id);
--   ALTER TABLE workspace_invitations ALTER COLUMN invited_by SET NOT NULL;
--   (the last statement fails once a deleted inviter has left a NULL; delete
--   or reassign those invitations first)
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

ALTER TABLE "workspace_invitations"
  ALTER COLUMN "invited_by" DROP NOT NULL;

DO $$
DECLARE
  target record;
  rel regclass;
  col smallint;
  existing record;
  fk_name text;
  leftover text;
BEGIN
  FOR target IN
    SELECT *
      FROM (VALUES
        ('workspace_invitations', 'invited_by',           'SET NULL'),
        ('subscription_changes',  'changed_by_user_id',   'SET NULL'),
        ('usage_events',          'triggered_by_user_id', 'SET NULL'),
        ('drip_posts',            'reviewed_by_id',       'SET NULL'),
        ('drip_campaign_history', 'performed_by_id',      'SET NULL'),
        ('canva_connections',     'user_id',              'CASCADE'),
        ('workspace',             'owner_id',             'RESTRICT')
      ) AS t (table_name, column_name, action)
  LOOP
    rel := to_regclass(format('%I', target.table_name));
    IF rel IS NULL THEN
      RAISE NOTICE '0093: table % does not exist, skipped',
        target.table_name;
      CONTINUE;
    END IF;

    SELECT a.attnum INTO col
      FROM pg_attribute a
     WHERE a.attrelid = rel
       AND a.attname = target.column_name
       AND NOT a.attisdropped;
    IF col IS NULL THEN
      RAISE EXCEPTION '0093: column %.% does not exist',
        target.table_name, target.column_name;
    END IF;

    FOR existing IN
      SELECT c.conname
        FROM pg_constraint c
       WHERE c.contype = 'f'
         AND c.conrelid = rel
         AND c.confrelid = 'users'::regclass
         AND c.conkey = ARRAY[col]
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',
                     target.table_name, existing.conname);
    END LOOP;

    fk_name := target.table_name || '_' || target.column_name || '_fkey';
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) '
        || 'REFERENCES "users" ("id") ON DELETE %s NOT VALID',
      target.table_name, fk_name, target.column_name, target.action);
    EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I',
                   target.table_name, fk_name);
  END LOOP;

  -- No foreign key to users may be left blocking a user delete.
  SELECT string_agg(
           format('%s.%s', c.conrelid::regclass, a.attname), ', '
           ORDER BY c.conrelid::regclass::text, a.attname)
    INTO leftover
    FROM pg_constraint c
    JOIN pg_attribute a
      ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.contype = 'f'
     AND c.confrelid = 'users'::regclass
     AND c.confdeltype = 'a';
  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION
      '0093: foreign keys to users still ON DELETE NO ACTION: %', leftover;
  END IF;
END $$;
