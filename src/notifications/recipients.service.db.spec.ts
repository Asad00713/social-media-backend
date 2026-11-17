import type { PoolClient } from 'pg';
import { seedMember, seedWorkspace } from '../inbox/testing/inbox-db';
import {
  describeDb,
  withRollbackDb,
  type DbType,
} from '../planner/testing/rollback-db';
import { RecipientsService } from './recipients.service';

// 0088 adds users.preferences, which userTimezone() reads.
const MIGRATIONS = ['0088_user_account_settings.sql'];
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

function run<T>(
  fn: (service: RecipientsService, client: PoolClient) => Promise<T>,
): Promise<T> {
  return withRollbackDb(MIGRATIONS, (db, client) =>
    fn(new RecipientsService(db), client),
  );
}

const rand = () => Math.random().toString(36).slice(2, 10);

/** An admin invitation for an existing user, in the given status. */
async function seedAdminInvitation(
  client: PoolClient,
  workspaceId: string,
  ownerId: string,
  status: 'PENDING' | 'REJECTED' | 'EXPIRED',
): Promise<string> {
  const u = await client.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, 'Invitee') RETURNING id`,
    [`invitee-${rand()}@example.test`],
  );
  const userId = u.rows[0].id;
  await client.query(
    `INSERT INTO workspace_invitations
       (workspace_id, email, user_id, role, status, invited_by, token, expires_at)
     VALUES ($1, $2, $3, 'ADMIN'::member_role, $4::invitation_status, $5,
             $6, now() + interval '7 days')`,
    [
      workspaceId,
      `i-${rand()}@example.test`,
      userId,
      status,
      ownerId,
      `tok-${rand()}`,
    ],
  );
  return userId;
}

describeDb('RecipientsService (database)', () => {
  it('admins() returns the owner plus ACCEPTED admins only', async () => {
    await run(async (service, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const admin = await seedMember(client, workspaceId, 'ADMIN');
      await seedMember(client, workspaceId, 'MEMBER');
      await seedMember(client, workspaceId, 'GUEST');
      await seedAdminInvitation(client, workspaceId, ownerId, 'PENDING');
      await seedAdminInvitation(client, workspaceId, ownerId, 'REJECTED');
      await seedAdminInvitation(client, workspaceId, ownerId, 'EXPIRED');

      const ids = (await service.admins(workspaceId)).map((r) => r.id);

      expect(ids).toEqual([ownerId, admin]);
    });
  });

  it('admins() lists the owner once when the owner also holds an ADMIN row', async () => {
    await run(async (service, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      await client.query(
        `INSERT INTO workspace_invitations
           (workspace_id, email, user_id, role, status, invited_by, token, expires_at, accepted_at)
         VALUES ($1, 'o@example.test', $2, 'ADMIN'::member_role, 'ACCEPTED', $2,
                 $3, now() + interval '7 days', now())`,
        [workspaceId, ownerId, `tok-${rand()}`],
      );

      expect((await service.admins(workspaceId)).map((r) => r.id)).toEqual([
        ownerId,
      ]);
    });
  });

  it('admins() of an unknown workspace is empty', async () => {
    await run(async (service) => {
      expect(await service.admins(UNKNOWN_ID)).toEqual([]);
    });
  });

  it('user() and owner() return id, email and name; unknown ids give null', async () => {
    await run(async (service, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);

      const owner = await service.owner(workspaceId);
      expect(owner).toEqual({
        id: ownerId,
        email: expect.stringContaining('@example.test') as string,
        name: 'Owner',
      });
      expect(await service.user(ownerId)).toEqual(owner);
      expect(await service.user(UNKNOWN_ID)).toBeNull();
      expect(await service.owner(UNKNOWN_ID)).toBeNull();
    });
  });

  it('workspace() returns id, name and timezone', async () => {
    await run(async (service, client) => {
      const { workspaceId } = await seedWorkspace(client, {
        timezone: 'Asia/Karachi',
      });

      expect(await service.workspace(workspaceId)).toEqual({
        id: workspaceId,
        name: 'Inbox WS',
        timezone: 'Asia/Karachi',
      });
      expect(await service.workspace(UNKNOWN_ID)).toBeNull();
    });
  });

  it('userTimezone() follows lastAccessedWorkspaceId, else UTC', async () => {
    await run(async (service, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client, {
        timezone: 'Asia/Karachi',
      });

      expect(await service.userTimezone(ownerId)).toBe('UTC');

      await client.query(
        `UPDATE users SET last_accessed_workspace_id = $1 WHERE id = $2`,
        [workspaceId, ownerId],
      );
      expect(await service.userTimezone(ownerId)).toBe('Asia/Karachi');

      // A dangling workspace id (deleted workspace) falls back to UTC.
      await client.query(
        `UPDATE users SET last_accessed_workspace_id = $1 WHERE id = $2`,
        [UNKNOWN_ID, ownerId],
      );
      expect(await service.userTimezone(ownerId)).toBe('UTC');
      expect(await service.userTimezone(UNKNOWN_ID)).toBe('UTC');
    });
  });

  it('userTimezone() prefers the saved preference, even with no last workspace', async () => {
    await run(async (service, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client, {
        timezone: 'Asia/Karachi',
      });
      const setPrefs = (json: string) =>
        client.query(`UPDATE users SET preferences = $1::jsonb WHERE id = $2`, [
          json,
          ownerId,
        ]);

      // No last-accessed workspace at all: the preference alone decides.
      await setPrefs('{"timezone":"Europe/Paris"}');
      expect(await service.userTimezone(ownerId)).toBe('Europe/Paris');

      // With a last-accessed workspace in another zone, the preference wins.
      await client.query(
        `UPDATE users SET last_accessed_workspace_id = $1 WHERE id = $2`,
        [workspaceId, ownerId],
      );
      expect(await service.userTimezone(ownerId)).toBe('Europe/Paris');

      // null (follow the device) and an invalid stored zone use the workspace.
      await setPrefs('{"timezone":null}');
      expect(await service.userTimezone(ownerId)).toBe('Asia/Karachi');
      await setPrefs('{"timezone":"Mars/Olympus"}');
      expect(await service.userTimezone(ownerId)).toBe('Asia/Karachi');
    });
  });
});

describe('RecipientsService.displayName', () => {
  const service = new RecipientsService(null as unknown as DbType);

  it('prefers the name, falls back to the email', () => {
    expect(service.displayName({ name: 'Sana', email: 's@x.pk' })).toBe('Sana');
    expect(service.displayName({ name: null, email: 's@x.pk' })).toBe('s@x.pk');
    expect(service.displayName({ name: '', email: 's@x.pk' })).toBe('s@x.pk');
  });
});
