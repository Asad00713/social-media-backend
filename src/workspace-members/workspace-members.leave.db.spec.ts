import type { PoolClient } from 'pg';
import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  describeDb,
  withRollbackDb,
  type DbType,
} from '../planner/testing/rollback-db';
import type { AppLinks } from '../email/links/app-links';
import { WorkspaceMembersService } from './workspace-members.service';

// 0080: REMOVED status, removed_at, removed_by. 0093: workspace columns the
// full-row workspace read selects. 0095: invited_by becomes NULLable, so a
// seeded membership needs no inviter.
const MIGRATIONS = [
  '0080_member_soft_removal.sql',
  '0092_user_account_settings.sql',
  '0093_workspace_settings.sql',
  '0095_users_fk_set_null.sql',
];

const rand = () => Math.random().toString(36).slice(2, 10);

async function seedUser(client: PoolClient, name: string) {
  const email = `lv-${rand()}@example.test`;
  const r = await client.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
    [email, name],
  );
  return { id: r.rows[0].id, email };
}

async function seedWorkspace(client: PoolClient, ownerId: string) {
  const r = await client.query<{ id: string }>(
    `INSERT INTO workspace (name, slug, owner_id) VALUES ('Leave Co', $1, $2) RETURNING id`,
    [`lv-${rand()}`, ownerId],
  );
  return r.rows[0].id;
}

async function seedMember(
  client: PoolClient,
  workspaceId: string,
  user: { id: string; email: string },
  role: 'ADMIN' | 'MEMBER' | 'GUEST',
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO workspace_invitations
       (workspace_id, email, user_id, role, status, token, expires_at, accepted_at)
     VALUES ($1, $2, $3, $4, 'ACCEPTED', $5, now() + interval '7 days', now())
     RETURNING id`,
    [workspaceId, user.email, user.id, role, rand() + rand()],
  );
  return r.rows[0].id;
}

interface RowState {
  status: string;
  removed_by: string | null;
  removed_at: Date | null;
}

async function rowState(client: PoolClient, id: string): Promise<RowState> {
  const r = await client.query<RowState>(
    `SELECT status, removed_by, removed_at FROM workspace_invitations WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

function run<T>(
  fn: (service: WorkspaceMembersService, client: PoolClient) => Promise<T>,
): Promise<T> {
  return withRollbackDb(MIGRATIONS, (db: DbType, client) => {
    const usage = {
      decrementMemberCount: jest.fn().mockResolvedValue(undefined),
    };
    const roleService = {
      isPlatformSuperAdmin: jest.fn().mockResolvedValue(false),
    };
    const service = new WorkspaceMembersService(
      db,
      usage as never,
      {} as never,
      {} as never,
      roleService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as AppLinks,
    );
    return fn(service, client);
  });
}

describeDb('WorkspaceMembersService.leaveWorkspace (database)', () => {
  it('a member leaves: their row is REMOVED by themselves', async () => {
    await run(async (service, client) => {
      const owner = await seedUser(client, 'Owner');
      const member = await seedUser(client, 'Member');
      const ws = await seedWorkspace(client, owner.id);
      const row = await seedMember(client, ws, member, 'MEMBER');

      await service.leaveWorkspace(ws, member.id);

      const state = await rowState(client, row);
      expect(state.status).toBe('REMOVED');
      expect(state.removed_by).toBe(member.id);
      expect(state.removed_at).not.toBeNull();
    });
  });

  it('a GUEST can leave too', async () => {
    await run(async (service, client) => {
      const owner = await seedUser(client, 'Owner');
      const guest = await seedUser(client, 'Guest');
      const ws = await seedWorkspace(client, owner.id);
      const row = await seedMember(client, ws, guest, 'GUEST');

      await service.leaveWorkspace(ws, guest.id);

      expect((await rowState(client, row)).status).toBe('REMOVED');
    });
  });

  it('an ADMIN can leave and the other members are untouched', async () => {
    await run(async (service, client) => {
      const owner = await seedUser(client, 'Owner');
      const admin = await seedUser(client, 'Admin');
      const other = await seedUser(client, 'Other');
      const ws = await seedWorkspace(client, owner.id);
      const adminRow = await seedMember(client, ws, admin, 'ADMIN');
      const otherRow = await seedMember(client, ws, other, 'MEMBER');

      await service.leaveWorkspace(ws, admin.id);

      expect((await rowState(client, adminRow)).status).toBe('REMOVED');
      expect((await rowState(client, otherRow)).status).toBe('ACCEPTED');
    });
  });

  it('the owner cannot leave: 409 OWNER_CANNOT_LEAVE', async () => {
    await run(async (service, client) => {
      const owner = await seedUser(client, 'Owner');
      const ws = await seedWorkspace(client, owner.id);

      const err = await service
        .leaveWorkspace(ws, owner.id)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        statusCode: 409,
        code: 'OWNER_CANNOT_LEAVE',
      });
    });
  });

  it('someone who is not a member gets a 404 and nothing changes', async () => {
    await run(async (service, client) => {
      const owner = await seedUser(client, 'Owner');
      const member = await seedUser(client, 'Member');
      const stranger = await seedUser(client, 'Stranger');
      const ws = await seedWorkspace(client, owner.id);
      const row = await seedMember(client, ws, member, 'MEMBER');

      await expect(
        service.leaveWorkspace(ws, stranger.id),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((await rowState(client, row)).status).toBe('ACCEPTED');
    });
  });

  it('leaving twice is a 404 the second time, not a second removal', async () => {
    await run(async (service, client) => {
      const owner = await seedUser(client, 'Owner');
      const member = await seedUser(client, 'Member');
      const ws = await seedWorkspace(client, owner.id);
      await seedMember(client, ws, member, 'MEMBER');

      await service.leaveWorkspace(ws, member.id);
      await expect(
        service.leaveWorkspace(ws, member.id),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
