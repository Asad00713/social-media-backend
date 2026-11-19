import type { PoolClient } from 'pg';
import { seedMember, seedWorkspace } from '../inbox/testing/inbox-db';
import {
  describeDb,
  withRollbackDb,
  type DbType,
} from '../planner/testing/rollback-db';
import { NotificationPreferencesRepository } from './notification-preferences.repository';

// 0043 is 0092's own prerequisite: 0092 backfills from planner_preferences.
const MIGRATIONS = [
  '0043_planner_preferences.sql',
  '0068_notification_preferences.sql',
  '0092_user_account_settings.sql',
];

function run<T>(
  fn: (
    repo: NotificationPreferencesRepository,
    client: PoolClient,
    db: DbType,
  ) => Promise<T>,
): Promise<T> {
  return withRollbackDb(MIGRATIONS, (db, client) =>
    fn(new NotificationPreferencesRepository(db), client, db),
  );
}

async function count(
  client: PoolClient,
  where = 'true',
  params: unknown[] = [],
): Promise<number> {
  const r = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM notification_preferences WHERE ${where}`,
    params,
  );
  return Number(r.rows[0].n);
}

describeDb('NotificationPreferencesRepository (database)', () => {
  it('upsert twice keeps one row per (user, ws, event, channel)', async () => {
    await run(async (repo, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      await repo.upsert(ownerId, workspaceId, 'member_activity', 'email', true);
      await repo.upsert(
        ownerId,
        workspaceId,
        'member_activity',
        'email',
        false,
      );

      expect(await count(client)).toBe(1);
      expect(await repo.findForUser(ownerId, workspaceId)).toEqual([
        { event: 'member_activity', channel: 'email', enabled: false },
      ]);

      // A different channel or event is a different row.
      await repo.upsert(ownerId, workspaceId, 'member_activity', 'app', true);
      await repo.upsert(ownerId, workspaceId, 'post_approved', 'email', true);
      expect(await count(client)).toBe(3);
    });
  });

  it('refreshes updated_at on a second write', async () => {
    await run(async (repo, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      await repo.upsert(ownerId, workspaceId, 'member_activity', 'email', true);
      await client.query(
        `UPDATE notification_preferences SET updated_at = now() - interval '1 day'`,
      );
      await repo.upsert(
        ownerId,
        workspaceId,
        'member_activity',
        'email',
        false,
      );
      expect(
        await count(client, `updated_at > now() - interval '1 minute'`),
      ).toBe(1);
    });
  });

  it('scopes rows to the user and the workspace', async () => {
    await run(async (repo, client) => {
      const a = await seedWorkspace(client);
      const b = await seedWorkspace(client);
      const memberId = await seedMember(client, a.workspaceId, 'MEMBER');
      await repo.upsert(
        a.ownerId,
        a.workspaceId,
        'post_failed',
        'email',
        false,
      );
      await repo.upsert(memberId, a.workspaceId, 'post_failed', 'email', true);
      await repo.upsert(a.ownerId, b.workspaceId, 'post_failed', 'email', true);

      expect(await repo.findForUser(a.ownerId, a.workspaceId)).toEqual([
        { event: 'post_failed', channel: 'email', enabled: false },
      ]);
      expect(await repo.findForUser(memberId, a.workspaceId)).toEqual([
        { event: 'post_failed', channel: 'email', enabled: true },
      ]);
      expect(await repo.findForUser(a.ownerId, b.workspaceId)).toEqual([
        { event: 'post_failed', channel: 'email', enabled: true },
      ]);
      expect(await repo.findForUser(a.ownerId, null)).toEqual([]);
    });
  });

  it('account-level rows (workspace_id NULL) upsert on the second partial index', async () => {
    await run(async (repo, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      await repo.upsert(ownerId, null, 'inactivity_reminder', 'email', false);
      await repo.upsert(ownerId, null, 'inactivity_reminder', 'email', true);
      await repo.upsert(ownerId, null, 'inactivity_reminder', 'email', false);

      expect(await count(client, 'workspace_id IS NULL')).toBe(1);
      expect(await repo.findForUser(ownerId, null)).toEqual([
        { event: 'inactivity_reminder', channel: 'email', enabled: false },
      ]);
      // Account rows never leak into a workspace read.
      expect(await repo.findForUser(ownerId, workspaceId)).toEqual([]);
    });
  });

  it('rejects channel "sms" (CHECK)', async () => {
    await run(async (_repo, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      await client.query('SAVEPOINT bad_channel');
      await expect(
        client.query(
          `INSERT INTO notification_preferences (user_id, workspace_id, event, channel, enabled)
           VALUES ($1, $2, 'post_failed', 'sms', true)`,
          [ownerId, workspaceId],
        ),
      ).rejects.toThrow(/notification_preferences_channel_chk/);
      await client.query('ROLLBACK TO SAVEPOINT bad_channel');
    });
  });

  it('cascades on workspace delete', async () => {
    await run(async (repo, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      await repo.upsert(ownerId, workspaceId, 'post_failed', 'email', false);
      await repo.upsert(ownerId, null, 'inactivity_reminder', 'email', false);
      await client.query('DELETE FROM workspace WHERE id = $1', [workspaceId]);

      expect(await repo.findForUser(ownerId, workspaceId)).toEqual([]);
      // The account-level row belongs to the user and survives.
      expect(await count(client)).toBe(1);
    });
  });

  it('cascades on user delete', async () => {
    await run(async (repo, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const memberId = await seedMember(client, workspaceId, 'MEMBER');
      await repo.upsert(memberId, workspaceId, 'post_failed', 'email', false);
      await repo.upsert(memberId, null, 'inactivity_reminder', 'email', false);
      await repo.upsert(ownerId, workspaceId, 'post_failed', 'email', false);
      await client.query('DELETE FROM users WHERE id = $1', [memberId]);

      expect(await count(client, 'user_id = $1', [memberId])).toBe(0);
      expect(await count(client)).toBe(1);
    });
  });

  describe('pause (users.notifications_paused_until)', () => {
    it('is null for a user who never paused', async () => {
      await run(async (repo, client) => {
        const { ownerId } = await seedWorkspace(client);
        expect(await repo.pausedUntil(ownerId)).toBeNull();
      });
    });

    it('is null for an unknown user', async () => {
      await run(async (repo) => {
        expect(
          await repo.pausedUntil('00000000-0000-4000-8000-000000000000'),
        ).toBeNull();
      });
    });

    it('stores an instant to the millisecond and reads it back as a Date', async () => {
      await run(async (repo, client) => {
        const { ownerId } = await seedWorkspace(client);
        const until = new Date('2026-12-01T10:30:15.123Z');
        await repo.setPausedUntil(ownerId, until);
        const read = await repo.pausedUntil(ownerId);
        expect(read).toBeInstanceOf(Date);
        expect(read?.toISOString()).toBe(until.toISOString());
      });
    });

    it('null clears it, and a second set overwrites the first', async () => {
      await run(async (repo, client) => {
        const { ownerId } = await seedWorkspace(client);
        await repo.setPausedUntil(ownerId, new Date('2026-12-01T00:00:00Z'));
        await repo.setPausedUntil(ownerId, new Date('2026-12-05T00:00:00Z'));
        expect((await repo.pausedUntil(ownerId))?.toISOString()).toBe(
          '2026-12-05T00:00:00.000Z',
        );
        await repo.setPausedUntil(ownerId, null);
        expect(await repo.pausedUntil(ownerId)).toBeNull();
        const raw = await client.query<{ n: string }>(
          'SELECT count(*) AS n FROM users WHERE id = $1 AND notifications_paused_until IS NULL',
          [ownerId],
        );
        expect(Number(raw.rows[0].n)).toBe(1);
      });
    });

    it('only touches the one user', async () => {
      await run(async (repo, client) => {
        const { workspaceId, ownerId } = await seedWorkspace(client);
        const memberId = await seedMember(client, workspaceId, 'MEMBER');
        await repo.setPausedUntil(ownerId, new Date('2026-12-01T00:00:00Z'));
        expect(await repo.pausedUntil(memberId)).toBeNull();
        expect(await repo.pausedUntil(ownerId)).not.toBeNull();
      });
    });
  });
});
