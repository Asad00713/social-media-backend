import type { PoolClient } from 'pg';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import {
  describeDb,
  withRollbackDb,
  type DbType,
} from '../planner/testing/rollback-db';
import type { AppLinks } from '../email/links/app-links';
import { WorkspaceMembersService } from './workspace-members.service';

// 0070/0071/0073: users columns every full users-row read selects (the
// invite guards read one). 0080: REMOVED status. 0092/0093: columns the
// full-row reads select, and invitations.message. 0095: invited_by is NULLable, so a seeded row needs no
// real inviter.
const MIGRATIONS = [
  '0070_users_sessions_revoked_at.sql',
  '0071_users_pending_email.sql',
  '0073_users_email_changed_at.sql',
  '0080_member_soft_removal.sql',
  '0092_user_account_settings.sql',
  '0093_workspace_settings.sql',
  '0095_users_fk_set_null.sql',
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
    role?: 'ADMIN' | 'MEMBER' | 'GUEST';
  },
): Promise<{ id: string; token: string }> {
  const token = rand() + rand();
  const r = await client.query<{ id: string }>(
    `INSERT INTO workspace_invitations
       (workspace_id, email, role, status, invited_by, token, expires_at, message, created_at)
     VALUES ($1, $2, $9::member_role, $3, $4, $5, $6::timestamp, $7, $8::timestamp)
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
      opts.role ?? 'MEMBER',
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
      incrementMemberCount: jest.fn().mockResolvedValue(undefined),
      decrementMemberCount: jest.fn().mockResolvedValue(undefined),
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

  it('a PENDING row past its expiry reads EXPIRED however long ago (it holds a seat); a stored EXPIRED one 40 days past is gone', async () => {
    await run(ROOMY, async (service, client) => {
      const owner = await seedUser(client, 'Owner');
      const ws = await seedWorkspace(client, owner.id);
      const lapsedPending = await seedInvitation(client, ws, {
        status: 'PENDING',
        expiresInMs: -2 * DAY_MS,
        invitedBy: owner.id,
        createdAtMsAgo: 1 * DAY_MS,
      });
      const oldPending = await seedInvitation(client, ws, {
        status: 'PENDING',
        expiresInMs: -40 * DAY_MS,
        invitedBy: owner.id,
        createdAtMsAgo: 2 * DAY_MS,
      });
      const oldExpired = await seedInvitation(client, ws, {
        status: 'EXPIRED',
        expiresInMs: -40 * DAY_MS,
        invitedBy: owner.id,
      });

      const list = await service.getPendingInvitations(ws, owner.id);

      expect(list.map((i) => [i.id, i.status])).toEqual([
        [lapsedPending.id, 'EXPIRED'],
        [oldPending.id, 'EXPIRED'],
      ]);
      expect(list.map((i) => i.id)).not.toContain(oldExpired.id);
    });
  });

  it('an EXPIRED row is hidden once its address has a live invite, joined, or is the owner', async () => {
    await run(ROOMY, async (service, client) => {
      const owner = await seedUser(client, 'Owner');
      const member = await seedUser(client, 'Member');
      const ws = await seedWorkspace(client, owner.id);
      const lonely = await seedInvitation(client, ws, {
        status: 'EXPIRED',
        expiresInMs: -3 * DAY_MS,
        invitedBy: owner.id,
        createdAtMsAgo: 1 * DAY_MS,
      });
      // Re-invited: a live PENDING invite to the same address (other case).
      const reinvitedEmail = `re-${rand()}@example.test`;
      await seedInvitation(client, ws, {
        status: 'EXPIRED',
        expiresInMs: -3 * DAY_MS,
        invitedBy: owner.id,
        email: reinvitedEmail,
      });
      const live = await seedInvitation(client, ws, {
        status: 'PENDING',
        expiresInMs: 5 * DAY_MS,
        invitedBy: owner.id,
        email: reinvitedEmail.toUpperCase(),
        createdAtMsAgo: 2 * DAY_MS,
      });
      // Joined since: an ACCEPTED row of the account behind the address.
      await seedInvitation(client, ws, {
        status: 'EXPIRED',
        expiresInMs: -3 * DAY_MS,
        invitedBy: owner.id,
        email: ` ${member.email.toUpperCase()} `,
      });
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
      // An old invite to the owner's own address.
      await seedInvitation(client, ws, {
        status: 'EXPIRED',
        expiresInMs: -3 * DAY_MS,
        invitedBy: owner.id,
        email: owner.email,
      });
      // A live PENDING row that itself lapsed does not supersede an EXPIRED one.
      const staleEmail = `stale-${rand()}@example.test`;
      const staleExpired = await seedInvitation(client, ws, {
        status: 'EXPIRED',
        expiresInMs: -3 * DAY_MS,
        invitedBy: owner.id,
        email: staleEmail,
        createdAtMsAgo: 4 * DAY_MS,
      });
      const stalePending = await seedInvitation(client, ws, {
        status: 'PENDING',
        expiresInMs: -1 * DAY_MS,
        invitedBy: owner.id,
        email: staleEmail,
        createdAtMsAgo: 3 * DAY_MS,
      });

      const list = await service.getPendingInvitations(ws, owner.id);

      expect(list.map((i) => i.id)).toEqual([
        lonely.id,
        live.id,
        stalePending.id,
        staleExpired.id,
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
      // last_login_at is `timestamp` (no zone) holding UTC wall-clock, as
      // drizzle writes it. A ::timestamptz cast would store the harness's
      // Karachi wall-clock instead, five hours off.
      await client.query(
        `UPDATE users SET last_login_at = $2::timestamp WHERE id = $1`,
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

  it('the owner own address is a 409 and the row stays expired', async () => {
    await run(ROOMY, async (service, client, sendNow) => {
      const owner = await seedUser(client, 'Owner');
      const ws = await seedWorkspace(client, owner.id);
      const inv = await seedInvitation(client, ws, {
        status: 'EXPIRED',
        expiresInMs: -2 * DAY_MS,
        invitedBy: owner.id,
        email: owner.email.toUpperCase(),
      });

      const err = await service
        .resendInvitation(ws, inv.id, owner.id)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).message).toBe(
        'User is already the workspace owner',
      );
      expect((await rowState(client, inv.id)).status).toBe('EXPIRED');
      expect(sendNow).not.toHaveBeenCalled();
    });
  });

  it('someone who has since joined is a 409 and the row stays expired', async () => {
    await run(ROOMY, async (service, client, sendNow) => {
      const owner = await seedUser(client, 'Owner');
      const member = await seedUser(client, 'Member');
      const ws = await seedWorkspace(client, owner.id);
      const inv = await seedInvitation(client, ws, {
        status: 'EXPIRED',
        expiresInMs: -2 * DAY_MS,
        invitedBy: owner.id,
        email: member.email,
      });
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

      const err = await service
        .resendInvitation(ws, inv.id, owner.id)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).message).toBe(
        'User is already a member of this workspace',
      );
      expect((await rowState(client, inv.id)).status).toBe('EXPIRED');
      expect(sendNow).not.toHaveBeenCalled();
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

describeDb('guests use no seat (database)', () => {
  it('pending guest invitations do not reduce freeSeats; pending member and admin ones do', async () => {
    await run({ membersLimit: 5, membersCount: 1 }, async (service, client) => {
      const owner = await seedUser(client, 'Owner');
      const ws = await seedWorkspace(client, owner.id);
      for (const role of ['GUEST', 'GUEST', 'MEMBER', 'ADMIN'] as const) {
        await seedInvitation(client, ws, {
          status: 'PENDING',
          expiresInMs: DAY_MS,
          invitedBy: owner.id,
          role,
        });
      }
      // 5 - (1 accepted + 2 seat-holding pending)
      expect(await service.freeSeats(ws)).toBe(2);
    });
  });

  it('a full workspace takes a batch of guests and refuses one of members, with the code', async () => {
    await run(FULL, async (service, client) => {
      const owner = await seedUser(client, 'Owner');
      const ws = await seedWorkspace(client, owner.id);

      const res = await service.batchInvite(
        ws,
        [
          { email: `${rand()}@example.test`, role: 'GUEST' },
          { email: `${rand()}@example.test`, role: 'GUEST' },
        ],
        owner.id,
      );
      expect(res.results.map((r) => r.status)).toEqual(['invited', 'invited']);

      const err = await service
        .batchInvite(
          ws,
          [{ email: `${rand()}@example.test`, role: 'MEMBER' }],
          owner.id,
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        statusCode: 403,
        code: 'SEAT_LIMIT_EXCEEDED',
      });
    });
  });

  it('an expired guest invitation is resent on a full workspace', async () => {
    await run(FULL, async (service, client) => {
      const owner = await seedUser(client, 'Owner');
      const ws = await seedWorkspace(client, owner.id);
      const inv = await seedInvitation(client, ws, {
        status: 'EXPIRED',
        expiresInMs: -2 * DAY_MS,
        invitedBy: owner.id,
        role: 'GUEST',
      });

      const view = await service.resendInvitation(ws, inv.id, owner.id);

      expect(view.status).toBe('PENDING');
      expect((await rowState(client, inv.id)).status).toBe('PENDING');
    });
  });

  it('promoting a guest needs a free seat, and demoting frees one', async () => {
    await run(FULL, async (service, client) => {
      const owner = await seedUser(client, 'Owner');
      const ws = await seedWorkspace(client, owner.id);
      const guest = await seedUser(client, 'Guest');
      const row = await client.query<{ id: string }>(
        `INSERT INTO workspace_invitations
           (workspace_id, email, user_id, role, status, token, expires_at, accepted_at)
         VALUES ($1, $2, $3, 'GUEST', 'ACCEPTED', $4, now(), now())
         RETURNING id`,
        [ws, guest.email, guest.id, rand() + rand()],
      );
      const id = row.rows[0].id;
      const roleOf = async () =>
        (
          await client.query<{ role: string }>(
            `SELECT role FROM workspace_invitations WHERE id = $1`,
            [id],
          )
        ).rows[0].role;

      const err = await service
        .updateMemberRole(ws, id, { role: 'MEMBER' } as never, owner.id)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        code: 'SEAT_LIMIT_EXCEEDED',
      });
      expect(await roleOf()).toBe('GUEST');
    });

    await run(ROOMY, async (service, client) => {
      const owner = await seedUser(client, 'Owner');
      const ws = await seedWorkspace(client, owner.id);
      const member = await seedUser(client, 'Member');
      const row = await client.query<{ id: string }>(
        `INSERT INTO workspace_invitations
           (workspace_id, email, user_id, role, status, token, expires_at, accepted_at)
         VALUES ($1, $2, $3, 'MEMBER', 'ACCEPTED', $4, now(), now())
         RETURNING id`,
        [ws, member.email, member.id, rand() + rand()],
      );
      const updated = await service.updateMemberRole(
        ws,
        row.rows[0].id,
        { role: 'GUEST' } as never,
        owner.id,
      );
      expect(updated.role).toBe('GUEST');
    });
  });
});
