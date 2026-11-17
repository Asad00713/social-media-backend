import type { PoolClient } from 'pg';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import {
  describeDb,
  withRollbackDb,
  type DbType,
} from '../planner/testing/rollback-db';
import type { AppLinks } from '../email/links/app-links';
import { WorkspaceMembersService } from './workspace-members.service';

// 0080: REMOVED status. 0088/0089: columns the full-row reads select, and
// invitations.message. 0091: invited_by is NULLable, so a seeded row needs no
// real inviter.
const MIGRATIONS = [
  '0080_member_soft_removal.sql',
  '0088_user_account_settings.sql',
  '0089_workspace_settings.sql',
  '0091_users_fk_set_null.sql',
];

const DAY_MS = 24 * 60 * 60 * 1000;
const rand = () => Math.random().toString(36).slice(2, 10);

async function seedUser(client: PoolClient, name: string) {
  const email = `inv-${rand()}@example.test`;
  const r = await client.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
    [email, name],
  );
  return { id: r.rows[0].id, email };
}

async function seedWorkspace(client: PoolClient, ownerId: string) {
  const r = await client.query<{ id: string }>(
    `INSERT INTO workspace (name, slug, owner_id) VALUES ('Invite Co', $1, $2) RETURNING id`,
    [`inv-${rand()}`, ownerId],
  );
  return r.rows[0].id;
}

/**
 * expires_at is `timestamp` (no zone) and drizzle reads and writes it as UTC.
 * The harness session runs in Asia/Karachi, so a seed through `now()` would be
 * five hours off: the instant goes in as a UTC ISO string instead.
 */
async function seedInvitation(
  client: PoolClient,
  workspaceId: string,
  opts: {
    status: 'PENDING' | 'EXPIRED' | 'ACCEPTED' | 'REMOVED' | 'REJECTED';
    expiresInMs: number;
    invitedBy?: string | null;
    email?: string;
    message?: string | null;
    createdAtMsAgo?: number;
  },
): Promise<{ id: string; token: string }> {
  const token = rand() + rand();
  const r = await client.query<{ id: string }>(
    `INSERT INTO workspace_invitations
       (workspace_id, email, role, status, invited_by, token, expires_at, message, created_at)
     VALUES ($1, $2, 'MEMBER', $3, $4, $5, $6::timestamp, $7, $8::timestamp)
     RETURNING id`,
    [
      workspaceId,
      opts.email ?? `${rand()}@example.test`,
      opts.status,
      opts.invitedBy ?? null,
      token,
      new Date(Date.now() + opts.expiresInMs).toISOString(),
      opts.message ?? null,
      new Date(Date.now() - (opts.createdAtMsAgo ?? 0)).toISOString(),
    ],
  );
  return { id: r.rows[0].id, token };
}

interface RowState {
  status: string;
  token: string;
  expires_at_text: string;
  expires_epoch: number;
}

async function rowState(client: PoolClient, id: string): Promise<RowState> {
  const r = await client.query<RowState>(
    `SELECT status, token, expires_at::text AS expires_at_text,
            extract(epoch FROM expires_at)::float8 AS expires_epoch
       FROM workspace_invitations WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

function run<T>(
  opts: { membersLimit: number; membersCount: number },
  fn: (
    service: WorkspaceMembersService,
    client: PoolClient,
    sendNow: jest.Mock,
  ) => Promise<T>,
): Promise<T> {
  return withRollbackDb(MIGRATIONS, (db: DbType, client) => {
    const usage = {
      getWorkspaceUsage: jest.fn().mockResolvedValue(opts),
    };
    const roleService = {
      isPlatformSuperAdmin: jest.fn().mockResolvedValue(false),
    };
    // Never a real email: the outbox is a stub.
    const sendNow = jest.fn().mockResolvedValue({ success: true });
    const recipients = {
      user: jest.fn().mockResolvedValue({
        id: 'u',
        email: 'r@example.test',
        name: 'Rehman',
      }),
      displayName: (u: { name: string }) => u.name,
    };
    const links = { invite: (token: string) => `https://app.test/i/${token}` };
    const service = new WorkspaceMembersService(
      db,
      usage as never,
      { sendNow } as never,
      {} as never,
      roleService as never,
      {} as never,
      {} as never,
      recipients as never,
      links as unknown as AppLinks,
    );
    return fn(service, client, sendNow);
  });
}

const ROOMY = { membersLimit: 10, membersCount: 1 };
const FULL = { membersLimit: 1, membersCount: 1 };

describeDb('WorkspaceMembersService invitations list (database)', () => {
  it('lists the live and the recently lapsed, not the old or the answered', async () => {
    await run(ROOMY, async (service, client) => {
      const owner = await seedUser(client, 'Rehman Owner');
      const ws = await seedWorkspace(client, owner.id);
      const live = await seedInvitation(client, ws, {
        status: 'PENDING',
        expiresInMs: 2 * DAY_MS,
        invitedBy: owner.id,
        message: 'Welcome',
        createdAtMsAgo: 1 * DAY_MS,
      });
      const lapsed = await seedInvitation(client, ws, {
        status: 'EXPIRED',
        expiresInMs: -3 * DAY_MS,
        invitedBy: owner.id,
        createdAtMsAgo: 10 * DAY_MS,
      });
      const old = await seedInvitation(client, ws, {
        status: 'EXPIRED',
        expiresInMs: -40 * DAY_MS,
        invitedBy: owner.id,
      });
      const accepted = await seedInvitation(client, ws, {
        status: 'ACCEPTED',
        expiresInMs: 5 * DAY_MS,
        invitedBy: owner.id,
      });

      const list = await service.getPendingInvitations(ws, owner.id);

      const ids = list.map((i) => i.id);
      expect(ids).toEqual([live.id, lapsed.id]); // newest first
      expect(ids).not.toContain(old.id);
      expect(ids).not.toContain(accepted.id);
      expect(list.map((i) => i.status)).toEqual(['PENDING', 'EXPIRED']);
      expect(list.map((i) => i.invitedByName)).toEqual([
        'Rehman Owner',
        'Rehman Owner',
      ]);
      expect(list[0].message).toBe('Welcome');
      expect(list[0].createdAt).toBeInstanceOf(Date);
      expect(list[1].expiresAt).toBeInstanceOf(Date);
      expect(JSON.stringify(list)).not.toContain(live.token);
      expect(list.every((i) => !('token' in i))).toBe(true);
    });
  });

  it('a PENDING row past its expiry reads EXPIRED; one 40 days past is gone', async () => {
    await run(ROOMY, async (service, client) => {
      const owner = await seedUser(client, 'Owner');
      const ws = await seedWorkspace(client, owner.id);
      const lapsedPending = await seedInvitation(client, ws, {
        status: 'PENDING',
        expiresInMs: -2 * DAY_MS,
        invitedBy: owner.id,
      });
      await seedInvitation(client, ws, {
        status: 'PENDING',
        expiresInMs: -40 * DAY_MS,
        invitedBy: owner.id,
      });

      const list = await service.getPendingInvitations(ws, owner.id);

      expect(list.map((i) => [i.id, i.status])).toEqual([
        [lapsedPending.id, 'EXPIRED'],
      ]);
    });
  });

  it('an invitation whose inviter is gone lists with invitedByName null', async () => {
    await run(ROOMY, async (service, client) => {
      const owner = await seedUser(client, 'Owner');
      const ws = await seedWorkspace(client, owner.id);
      await seedInvitation(client, ws, {
        status: 'PENDING',
        expiresInMs: DAY_MS,
        invitedBy: null,
      });
      const [only] = await service.getPendingInvitations(ws, owner.id);
      expect(only.invitedByName).toBeNull();
    });
  });
});

describeDb('WorkspaceMembersService.getMembers lastActiveAt (database)', () => {
  it('is the last sign-in as an ISO string, null for a member who never signed in', async () => {
    await run(ROOMY, async (service, client) => {
      const owner = await seedUser(client, 'Owner');
      const member = await seedUser(client, 'Member');
      const ws = await seedWorkspace(client, owner.id);
      await client.query(
        `UPDATE users SET last_login_at = $2::timestamptz WHERE id = $1`,
        [owner.id, '2026-11-16T08:30:00.000Z'],
      );
      await client.query(
        `INSERT INTO workspace_invitations
           (workspace_id, email, user_id, role, status, token, expires_at, accepted_at)
         VALUES ($1, $2, $3, 'MEMBER', 'ACCEPTED', $4, $5::timestamp, $5::timestamp)`,
        [
          ws,
          member.email,
          member.id,
          rand() + rand(),
          new Date().toISOString(),
        ],
      );

      const res = await service.getMembers(ws, owner.id);

      expect(res.owner?.lastActiveAt).toBe('2026-11-16T08:30:00.000Z');
      expect(res.members).toHaveLength(1);
      expect(res.members[0].lastActiveAt).toBeNull();
    });
  });
});

describeDb('WorkspaceMembersService.resendInvitation (database)', () => {
  it('a pending invite gets 7 more days on the same token, and the email goes out', async () => {
    await run(FULL, async (service, client, sendNow) => {
      const owner = await seedUser(client, 'Owner');
      const ws = await seedWorkspace(client, owner.id);
      const inv = await seedInvitation(client, ws, {
        status: 'PENDING',
        expiresInMs: 1 * DAY_MS,
        invitedBy: owner.id,
        message: 'See you inside',
      });
      const before = await rowState(client, inv.id);

      const view = await service.resendInvitation(ws, inv.id, owner.id);

      const after = await rowState(client, inv.id);
      expect(after.expires_at_text).not.toBe(before.expires_at_text);
      expect(after.token).toBe(inv.token);
      expect(after.status).toBe('PENDING');
      expect(
        Math.abs(after.expires_epoch - (Date.now() + 7 * DAY_MS) / 1000),
      ).toBeLessThan(120);
      expect(view.status).toBe('PENDING');
      expect(JSON.stringify(view)).not.toContain(inv.token);
      expect(sendNow).toHaveBeenCalledTimes(1);
      expect(sendNow.mock.calls[0][0].props.message).toBe('See you inside');
    });
  });

  it('an expired invite with no free seat is 403 and the row is untouched', async () => {
    await run(FULL, async (service, client, sendNow) => {
      const owner = await seedUser(client, 'Owner');
      const ws = await seedWorkspace(client, owner.id);
      const inv = await seedInvitation(client, ws, {
        status: 'EXPIRED',
        expiresInMs: -2 * DAY_MS,
        invitedBy: owner.id,
      });
      const before = await rowState(client, inv.id);

      const err = await service
        .resendInvitation(ws, inv.id, owner.id)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).message).toContain(
        'SEAT_LIMIT_EXCEEDED',
      );
      expect(await rowState(client, inv.id)).toEqual(before);
      expect(sendNow).not.toHaveBeenCalled();
    });
  });

  it('a PENDING row past its expiry with no free seat is 403 too', async () => {
    await run(FULL, async (service, client) => {
      const owner = await seedUser(client, 'Owner');
      const ws = await seedWorkspace(client, owner.id);
      const inv = await seedInvitation(client, ws, {
        status: 'PENDING',
        expiresInMs: -1 * DAY_MS,
        invitedBy: owner.id,
      });
      const before = await rowState(client, inv.id);

      await expect(
        service.resendInvitation(ws, inv.id, owner.id),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(await rowState(client, inv.id)).toEqual(before);
    });
  });

  it('an expired invite with a free seat turns PENDING again with a new expiry', async () => {
    await run(ROOMY, async (service, client) => {
      const owner = await seedUser(client, 'Owner');
      const ws = await seedWorkspace(client, owner.id);
      const inv = await seedInvitation(client, ws, {
        status: 'EXPIRED',
        expiresInMs: -2 * DAY_MS,
        invitedBy: owner.id,
      });

      const view = await service.resendInvitation(ws, inv.id, owner.id);

      const after = await rowState(client, inv.id);
      expect(after.status).toBe('PENDING');
      expect(after.token).toBe(inv.token);
      expect(
        Math.abs(after.expires_epoch - (Date.now() + 7 * DAY_MS) / 1000),
      ).toBeLessThan(120);
      expect(view.status).toBe('PENDING');
    });
  });

  it('another live invite to the same address is a 409 and the expired row stays expired', async () => {
    await run(ROOMY, async (service, client) => {
      const owner = await seedUser(client, 'Owner');
      const ws = await seedWorkspace(client, owner.id);
      const email = `dup-${rand()}@example.test`;
      const expired = await seedInvitation(client, ws, {
        status: 'EXPIRED',
        expiresInMs: -2 * DAY_MS,
        invitedBy: owner.id,
        email,
      });
      await seedInvitation(client, ws, {
        status: 'PENDING',
        expiresInMs: 3 * DAY_MS,
        invitedBy: owner.id,
        email: email.toUpperCase(),
      });

      const err = await service
        .resendInvitation(ws, expired.id, owner.id)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        code: 'INVITATION_ALREADY_PENDING',
      });
      expect((await rowState(client, expired.id)).status).toBe('EXPIRED');
    });
  });

  it.each(['ACCEPTED', 'REMOVED', 'REJECTED'] as const)(
    'a %s row is 409 INVITATION_NOT_RESENDABLE and unchanged',
    async (status) => {
      await run(ROOMY, async (service, client, sendNow) => {
        const owner = await seedUser(client, 'Owner');
        const ws = await seedWorkspace(client, owner.id);
        const inv = await seedInvitation(client, ws, {
          status,
          expiresInMs: 3 * DAY_MS,
          invitedBy: owner.id,
        });
        const before = await rowState(client, inv.id);

        const err = await service
          .resendInvitation(ws, inv.id, owner.id)
          .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ConflictException);
        expect((err as ConflictException).getResponse()).toMatchObject({
          statusCode: 409,
          code: 'INVITATION_NOT_RESENDABLE',
        });
        expect(await rowState(client, inv.id)).toEqual(before);
        expect(sendNow).not.toHaveBeenCalled();
      });
    },
  );

  it('an invitation of another workspace is a 404', async () => {
    await run(ROOMY, async (service, client) => {
      const owner = await seedUser(client, 'Owner');
      const ws = await seedWorkspace(client, owner.id);
      const other = await seedWorkspace(client, owner.id);
      const inv = await seedInvitation(client, other, {
        status: 'EXPIRED',
        expiresInMs: -DAY_MS,
        invitedBy: owner.id,
      });
      await expect(
        service.resendInvitation(ws, inv.id, owner.id),
      ).rejects.toMatchObject({ status: 404 });
    });
  });
});
