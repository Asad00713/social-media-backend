import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AppLinks } from 'src/email/links/app-links';
import { WorkspaceMembersService } from './workspace-members.service';

/**
 * Guests are free: they never use a seat. Pinned from every side a seat is
 * checked or counted: the invite gates, resend, accept, restore, remove,
 * `freeSeats` and role changes. Each case asserts the invariant, so putting a
 * guest back on a seat breaks one of them.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const OWNER = 'owner-user';
const MEMBER_USER = 'member-user';

const links = new AppLinks({
  get: (key: string) =>
    key === 'FRONTEND_URL' ? 'https://app.schedura.ai' : undefined,
} as unknown as ConfigService);

function makeUsage(membersLimit: number, membersCount: number) {
  return {
    getWorkspaceUsage: jest
      .fn()
      .mockResolvedValue({ membersLimit, membersCount }),
    incrementMemberCount: jest.fn().mockResolvedValue(undefined),
    decrementMemberCount: jest.fn().mockResolvedValue(undefined),
  };
}

function makeService(db: any, usage: any) {
  db.execute ??= jest.fn().mockResolvedValue(undefined);
  db.transaction ??= (fn: (tx: unknown) => unknown) => fn(db);
  db.select ??= () => ({
    from: () => ({ where: () => Promise.resolve([{ count: 0 }]) }),
  });
  return new WorkspaceMembersService(
    db,
    usage,
    { sendNow: jest.fn().mockResolvedValue({ success: true }) } as any,
    {} as any,
    { isPlatformSuperAdmin: jest.fn().mockResolvedValue(false) } as any,
    { notify: jest.fn().mockResolvedValue(undefined) } as any,
    { invitationAccepted: jest.fn().mockResolvedValue(undefined) } as any,
    {
      user: jest.fn().mockResolvedValue(null),
      displayName: (u: { name?: string | null; email: string }) =>
        u.name ?? u.email,
    } as any,
    links,
  );
}

/** An update chain that records what it was given and answers `rows`. */
function updateChain(rows: unknown[]) {
  const sets: any[] = [];
  const update = jest.fn(() => ({
    set: (set: any) => {
      sets.push(set);
      return {
        where: () => ({
          returning: () =>
            Promise.resolve(rows.map((r) => ({ ...(r as object), ...set }))),
        }),
      };
    },
  }));
  return { update, sets };
}

/** A workspace the caller owns, with `pending` invitations already out. */
function inviteDb(pending: { email: string; role: string }[] = []) {
  const insert = jest.fn(() => ({
    values: (v: any) => ({
      returning: () =>
        Promise.resolve([
          {
            id: `inv-${v.email}`,
            email: v.email,
            role: v.role,
            token: 't',
            expiresAt: new Date(),
          },
        ]),
    }),
  }));
  return {
    query: {
      workspace: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: WS, ownerId: OWNER, name: 'Acme' }),
      },
      users: { findFirst: jest.fn().mockResolvedValue(undefined) },
      workspaceInvitation: {
        findFirst: jest.fn().mockResolvedValue(undefined),
        findMany: jest.fn().mockResolvedValue(pending),
      },
    },
    insert,
  } as any;
}

async function rejection(p: Promise<unknown>): Promise<any> {
  return p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e) => e,
  );
}

describe('a seat-limit 403 carries a machine code', () => {
  it('keeps the old message text and adds code SEAT_LIMIT_EXCEEDED', async () => {
    const db = inviteDb();
    const err = await rejection(
      makeService(db, makeUsage(2, 2)).batchInvite(
        WS,
        [{ email: 'a@x.pk', role: 'MEMBER' }],
        OWNER,
      ),
    );
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getStatus()).toBe(403);
    expect(err.getResponse()).toEqual({
      statusCode: 403,
      error: 'Forbidden',
      code: 'SEAT_LIMIT_EXCEEDED',
      message: 'SEAT_LIMIT_EXCEEDED: 0 seat(s) left, 1 requested',
    });
    expect(err.message).toMatch(/^SEAT_LIMIT_EXCEEDED:/);
  });
});

describe('guests and the invite gates', () => {
  it('a full workspace accepts a batch of guests', async () => {
    const db = inviteDb();
    const usage = makeUsage(2, 2); // no free seat at all
    const res = await makeService(db, usage).batchInvite(
      WS,
      [
        { email: 'a@x.pk', role: 'GUEST' },
        { email: 'b@x.pk', role: 'GUEST' },
        { email: 'c@x.pk', role: 'GUEST' },
      ],
      OWNER,
    );
    expect(res.results.map((r) => r.status)).toEqual([
      'invited',
      'invited',
      'invited',
    ]);
    expect(db.insert).toHaveBeenCalledTimes(3);
  });

  it('a mixed batch counts only the invites that take a seat', async () => {
    const usage = makeUsage(3, 1); // 2 free seats
    // 2 seat roles + 3 guests = 5 invites, only 2 need a seat: fits.
    const db = inviteDb();
    const res = await makeService(db, usage).batchInvite(
      WS,
      [
        { email: 'a@x.pk', role: 'MEMBER' },
        { email: 'g1@x.pk', role: 'GUEST' },
        { email: 'b@x.pk', role: 'ADMIN' },
        { email: 'g2@x.pk', role: 'GUEST' },
        { email: 'g3@x.pk', role: 'GUEST' },
      ],
      OWNER,
    );
    expect(res.results).toHaveLength(5);

    // 3 seat roles against 2 free: refused, even with a guest in the batch,
    // and the message counts the 3 that need a seat, not the 4 invites.
    const db2 = inviteDb();
    const err = await rejection(
      makeService(db2, usage).batchInvite(
        WS,
        [
          { email: 'a@x.pk', role: 'MEMBER' },
          { email: 'b@x.pk' }, // no role: defaults to MEMBER
          { email: 'c@x.pk', role: 'ADMIN' },
          { email: 'g@x.pk', role: 'GUEST' },
        ],
        OWNER,
      ),
    );
    expect(err.getResponse()).toMatchObject({
      code: 'SEAT_LIMIT_EXCEEDED',
      message: 'SEAT_LIMIT_EXCEEDED: 2 seat(s) left, 3 requested',
    });
    expect(db2.insert).not.toHaveBeenCalled();
  });

  it('a single guest invite is never refused for seats; a member one is', async () => {
    const usage = makeUsage(2, 2);
    const db = inviteDb();
    const res = await makeService(db, usage).inviteMember(
      WS,
      { email: 'g@x.pk', role: 'GUEST' } as any,
      OWNER,
    );
    expect(res.invitation.role).toBe('GUEST');
    expect(usage.getWorkspaceUsage).not.toHaveBeenCalled();

    const db2 = inviteDb();
    const err = await rejection(
      makeService(db2, usage).inviteMember(
        WS,
        { email: 'm@x.pk', role: 'MEMBER' } as any,
        OWNER,
      ),
    );
    expect(err.getResponse()).toMatchObject({ code: 'SEAT_LIMIT_EXCEEDED' });
    expect(db2.insert).not.toHaveBeenCalled();
  });
});

describe('freeSeats', () => {
  it('pending guest invitations do not reduce it; pending member and admin ones do', async () => {
    const svc = makeService(
      inviteDb([
        { email: 'g1@x.pk', role: 'GUEST' },
        { email: 'g2@x.pk', role: 'GUEST' },
        { email: 'm@x.pk', role: 'MEMBER' },
        { email: 'a@x.pk', role: 'ADMIN' },
      ]),
      makeUsage(5, 1),
    );
    // 5 - (1 accepted + 2 seat-holding pending)
    await expect(svc.freeSeats(WS)).resolves.toBe(2);
  });

  it('leaves out the one address asked about, but only if it holds a seat', async () => {
    const svc = makeService(
      inviteDb([
        { email: 'm@x.pk', role: 'MEMBER' },
        { email: 'g@x.pk', role: 'GUEST' },
      ]),
      makeUsage(3, 1),
    );
    await expect(svc.freeSeats(WS)).resolves.toBe(1);
    await expect(svc.freeSeats(WS, 'm@x.pk')).resolves.toBe(2);
    await expect(svc.freeSeats(WS, 'g@x.pk')).resolves.toBe(1);
  });
});

describe('resend', () => {
  function resendDb(role: string) {
    const row = {
      id: 'inv1',
      workspaceId: WS,
      email: 'Sana@X.pk',
      role,
      token: 'tok',
      invitedBy: OWNER,
      userId: null,
      status: 'EXPIRED',
      expiresAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    };
    const { update, sets } = updateChain([row]);
    const db: any = {
      query: {
        workspace: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: WS, ownerId: OWNER, name: 'Acme' }),
        },
        users: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce({ id: OWNER, email: 'o@x.pk' })
            .mockResolvedValue(undefined),
        },
        workspaceInvitation: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce(row)
            .mockResolvedValue(undefined),
          findMany: jest.fn().mockResolvedValue([]),
        },
      },
      update,
    };
    return { db, sets };
  }

  it('an expired GUEST invite comes back on a full workspace; a MEMBER one does not', async () => {
    const guest = resendDb('GUEST');
    const res = await makeService(guest.db, makeUsage(2, 2)).resendInvitation(
      WS,
      'inv1',
      OWNER,
    );
    expect(res.status).toBe('PENDING');
    expect(guest.sets[0].status).toBe('PENDING');

    const member = resendDb('MEMBER');
    const err = await rejection(
      makeService(member.db, makeUsage(2, 2)).resendInvitation(
        WS,
        'inv1',
        OWNER,
      ),
    );
    expect(err.getResponse()).toMatchObject({ code: 'SEAT_LIMIT_EXCEEDED' });
    expect(member.sets).toHaveLength(0);
  });
});

describe('accept and remove count seats, not people', () => {
  function acceptDb(role: string) {
    const { update } = updateChain([
      { id: 'inv1', workspaceId: WS, status: 'ACCEPTED', role },
    ]);
    return {
      query: {
        workspaceInvitation: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce({
              id: 'inv1',
              workspaceId: WS,
              status: 'PENDING',
              role,
              email: 'sana@x.pk',
              expiresAt: new Date(Date.now() + 60_000),
            })
            .mockResolvedValueOnce(undefined),
        },
        users: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: MEMBER_USER, email: 'sana@x.pk' }),
        },
      },
      update,
    } as any;
  }

  function serviceFor(db: any, usage: any) {
    const svc = makeService(db, usage);
    // The post-commit verify/notify steps are not under test.
    (svc as any).usersService = {
      verifyEmail: jest.fn().mockResolvedValue(undefined),
      markOnboardingCompleted: jest.fn().mockResolvedValue(undefined),
    };
    (svc as any).notifyInviterOfAcceptance = jest
      .fn()
      .mockResolvedValue(undefined);
    return svc;
  }

  it('accepting a guest invitation does not count a seat; a member one does', async () => {
    const guestUsage = makeUsage(2, 2);
    await serviceFor(acceptDb('GUEST'), guestUsage).acceptInvitation(
      'tok',
      MEMBER_USER,
    );
    expect(guestUsage.incrementMemberCount).not.toHaveBeenCalled();

    const memberUsage = makeUsage(5, 1);
    await serviceFor(acceptDb('MEMBER'), memberUsage).acceptInvitation(
      'tok',
      MEMBER_USER,
    );
    expect(memberUsage.incrementMemberCount).toHaveBeenCalledWith(
      WS,
      MEMBER_USER,
      MEMBER_USER,
    );
  });

  function removalDb(role: string) {
    const { update } = updateChain([{ id: 'm1' }]);
    return {
      query: {
        workspace: {
          findFirst: jest.fn().mockResolvedValue({ id: WS, ownerId: OWNER }),
        },
        workspaceInvitation: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'm1',
            userId: MEMBER_USER,
            status: 'ACCEPTED',
            role,
          }),
        },
      },
      update,
    } as any;
  }

  it('removing a guest frees no seat; removing a member does', async () => {
    const guestUsage = makeUsage(2, 1);
    const svc = makeService(removalDb('GUEST'), guestUsage);
    (svc as any).notifyMemberRemoved = jest.fn().mockResolvedValue(undefined);
    await svc.removeMember(WS, 'm1', OWNER);
    expect(guestUsage.decrementMemberCount).not.toHaveBeenCalled();

    const memberUsage = makeUsage(2, 2);
    const svc2 = makeService(removalDb('MEMBER'), memberUsage);
    (svc2 as any).notifyMemberRemoved = jest.fn().mockResolvedValue(undefined);
    await svc2.removeMember(WS, 'm1', OWNER);
    expect(memberUsage.decrementMemberCount).toHaveBeenCalledWith(
      WS,
      OWNER,
      MEMBER_USER,
    );
  });
});

describe('restoring a removed member', () => {
  function restoreDb(role: string) {
    const row = {
      id: 'm1',
      workspaceId: WS,
      userId: MEMBER_USER,
      email: 'Sana@X.pk',
      role,
      status: 'REMOVED',
      token: 'secret',
      removedBy: OWNER,
      removedAt: new Date(Date.now() - 60_000),
    };
    const { update } = updateChain([{ ...row, status: 'ACCEPTED' }]);
    return {
      query: {
        workspace: {
          findFirst: jest.fn().mockResolvedValue({ id: WS, ownerId: OWNER }),
        },
        workspaceInvitation: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce(row)
            .mockResolvedValue(undefined),
          findMany: jest.fn().mockResolvedValue([]),
        },
      },
      update,
      delete: jest.fn(() => ({
        where: () => ({ returning: () => Promise.resolve([]) }),
      })),
    } as any;
  }

  it('a removed guest comes back on a full workspace and counts no seat; a member does not', async () => {
    const guestUsage = makeUsage(2, 2);
    const res = await makeService(restoreDb('GUEST'), guestUsage).restoreMember(
      WS,
      'm1',
      OWNER,
    );
    expect(res.member).toMatchObject({ role: 'GUEST', status: 'ACCEPTED' });
    expect(guestUsage.incrementMemberCount).not.toHaveBeenCalled();

    const memberUsage = makeUsage(2, 2);
    const err = await rejection(
      makeService(restoreDb('MEMBER'), memberUsage).restoreMember(
        WS,
        'm1',
        OWNER,
      ),
    );
    expect(err.getResponse()).toMatchObject({ code: 'SEAT_LIMIT_EXCEEDED' });
    expect(memberUsage.incrementMemberCount).not.toHaveBeenCalled();
  });
});

describe('changing a role moves a seat only across the guest line', () => {
  function roleDb(currentRole: string) {
    const row = {
      id: 'm1',
      workspaceId: WS,
      userId: MEMBER_USER,
      status: 'ACCEPTED',
      role: currentRole,
      token: 'secret',
    };
    const { update, sets } = updateChain([row]);
    const db: any = {
      query: {
        workspace: {
          findFirst: jest.fn().mockResolvedValue({ id: WS, ownerId: OWNER }),
        },
        workspaceInvitation: {
          findFirst: jest.fn().mockResolvedValue(row),
          findMany: jest.fn().mockResolvedValue([]),
        },
      },
      update,
    };
    return { db, sets };
  }

  it('promoting a guest with no free seat is 403 SEAT_LIMIT_EXCEEDED and nothing changes', async () => {
    for (const to of ['MEMBER', 'ADMIN']) {
      const { db, sets } = roleDb('GUEST');
      const usage = makeUsage(2, 2);
      const err = await rejection(
        makeService(db, usage).updateMemberRole(
          WS,
          'm1',
          { role: to } as any,
          OWNER,
        ),
      );
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toMatchObject({
        statusCode: 403,
        code: 'SEAT_LIMIT_EXCEEDED',
      });
      expect(sets).toHaveLength(0);
      expect(usage.incrementMemberCount).not.toHaveBeenCalled();
      // Checked under the workspace's seat lock.
      expect(db.execute).toHaveBeenCalledTimes(1);
    }
  });

  it('a pending seat-holding invite blocks a promotion too', async () => {
    const { db, sets } = roleDb('GUEST');
    db.query.workspaceInvitation.findMany.mockResolvedValue([
      { email: 'p@x.pk', role: 'MEMBER' },
    ]);
    const err = await rejection(
      makeService(db, makeUsage(2, 1)).updateMemberRole(
        WS,
        'm1',
        { role: 'MEMBER' } as any,
        OWNER,
      ),
    );
    expect(err.getResponse()).toMatchObject({ code: 'SEAT_LIMIT_EXCEEDED' });
    expect(sets).toHaveLength(0);
  });

  it('promoting a guest with a free seat counts it, and the row comes back without its token', async () => {
    const { db, sets } = roleDb('GUEST');
    const usage = makeUsage(3, 2);
    const res = await makeService(db, usage).updateMemberRole(
      WS,
      'm1',
      { role: 'MEMBER' } as any,
      OWNER,
    );
    expect(sets[0]).toMatchObject({ role: 'MEMBER' });
    expect(usage.incrementMemberCount).toHaveBeenCalledWith(
      WS,
      OWNER,
      MEMBER_USER,
    );
    expect(usage.decrementMemberCount).not.toHaveBeenCalled();
    expect(res).not.toHaveProperty('token');
  });

  it('demoting to guest frees the seat, even on a full workspace', async () => {
    for (const from of ['MEMBER', 'ADMIN']) {
      const { db, sets } = roleDb(from);
      const usage = makeUsage(2, 2);
      await makeService(db, usage).updateMemberRole(
        WS,
        'm1',
        { role: 'GUEST' } as any,
        OWNER,
      );
      expect(sets[0]).toMatchObject({ role: 'GUEST' });
      expect(usage.decrementMemberCount).toHaveBeenCalledWith(
        WS,
        OWNER,
        MEMBER_USER,
      );
      expect(usage.incrementMemberCount).not.toHaveBeenCalled();
    }
  });

  it('moving between two seat roles, or guest to guest, touches no counter and checks no seat', async () => {
    for (const [from, to] of [
      ['ADMIN', 'MEMBER'],
      ['MEMBER', 'ADMIN'],
      ['GUEST', 'GUEST'],
    ]) {
      const { db, sets } = roleDb(from);
      const usage = makeUsage(2, 2); // full: must not matter
      await makeService(db, usage).updateMemberRole(
        WS,
        'm1',
        { role: to } as any,
        OWNER,
      );
      expect(sets[0]).toMatchObject({ role: to });
      expect(usage.incrementMemberCount).not.toHaveBeenCalled();
      expect(usage.decrementMemberCount).not.toHaveBeenCalled();
      expect(usage.getWorkspaceUsage).not.toHaveBeenCalled();
    }
  });
});
