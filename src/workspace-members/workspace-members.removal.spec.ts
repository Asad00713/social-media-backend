import 'reflect-metadata';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ParseUUIDPipe,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { AppLinks } from 'src/email/links/app-links';
import {
  MEMBER_RESTORE_WINDOW_MS,
  WorkspaceMembersService,
} from './workspace-members.service';
import { WorkspaceMembersController } from './workspace-members.controller';
import { REQUIRE_CAPABILITY } from './require-capability.decorator';
import { WorkspaceRoleService } from './workspace-role.service';

const dialect = new PgDialect();
const whereOf = (arg: any) => dialect.sqlToQuery(arg.where);

const WS = '11111111-1111-4111-8111-111111111111';
const ADMIN = 'admin-user';
const OWNER = 'owner-user';
const OTHER_ADMIN = 'other-admin-user';
const MEMBER_USER = 'member-user';

const roleService = {
  isPlatformSuperAdmin: jest.fn().mockResolvedValue(false),
};

/** An update chain that records what it was given and answers `rows`. */
function updateChain(rows: unknown[]) {
  const calls: { set: any; where: any }[] = [];
  const update = jest.fn(() => ({
    set: (set: any) => ({
      where: (where: any) => {
        calls.push({ set, where });
        return { returning: () => Promise.resolve(rows) };
      },
    }),
  }));
  return { update, calls };
}

/** The SQL of every statement run through `db.execute` (the seat lock). */
const executed = (db: any): string[] =>
  db.execute.mock.calls.map(
    (c: any[]) => dialect.sqlToQuery(c[0]).sql as string,
  );

/** The email and notification collaborators, faked; tests read the calls. */
function makeMail() {
  return {
    outbox: { sendNow: jest.fn().mockResolvedValue({ success: true }) },
    notify: { notify: jest.fn().mockResolvedValue(undefined) },
    emitter: { memberRemoved: jest.fn().mockResolvedValue(undefined) },
    recipients: {
      user: jest.fn().mockResolvedValue(null),
      displayName: (u: { name?: string | null; email: string }) =>
        u.name ?? u.email,
    },
  };
}

type Mail = ReturnType<typeof makeMail>;

const links = new AppLinks({
  get: (key: string) =>
    key === 'FRONTEND_URL' ? 'https://app.schedura.ai' : undefined,
} as unknown as ConfigService);

function makeService(db: any, over: { usage?: any; mail?: Mail } = {}) {
  // Transactions and savepoints run the callback on the same mock; the
  // seat lock is recorded by `execute`. The invitation email counts channels
  // and members through `select`.
  db.execute ??= jest.fn().mockResolvedValue(undefined);
  db.transaction ??= (fn: (tx: unknown) => unknown) => fn(db);
  db.select ??= () => ({
    from: () => ({ where: () => Promise.resolve([{ count: 0 }]) }),
  });
  const mail = over.mail ?? makeMail();
  return new WorkspaceMembersService(
    db,
    over.usage ?? {
      getWorkspaceUsage: jest
        .fn()
        .mockResolvedValue({ membersLimit: 5, membersCount: 1 }),
      incrementMemberCount: jest.fn().mockResolvedValue(undefined),
      decrementMemberCount: jest.fn().mockResolvedValue(undefined),
    },
    mail.outbox as any,
    {} as any,
    roleService as any,
    mail.notify as any,
    mail.emitter as any,
    mail.recipients as any,
    links,
  );
}

const capabilityOf = (handler: keyof WorkspaceMembersController) =>
  Reflect.getMetadata(
    REQUIRE_CAPABILITY,
    WorkspaceMembersController.prototype[handler],
  );

describe('the new team routes', () => {
  it('both demand team:manage (ADMIN and up)', () => {
    expect(capabilityOf('getInvitationLink')).toBe('team:manage');
    expect(capabilityOf('restoreMember')).toBe('team:manage');
  });

  it('parse their row ids as UUIDs (a bad id is a 400, never a Postgres error)', () => {
    const pipesOf = (handler: string) =>
      Object.values(
        Reflect.getMetadata(
          ROUTE_ARGS_METADATA,
          WorkspaceMembersController,
          handler,
        ) as Record<string, { data?: string; pipes: unknown[] }>,
      )
        .filter((a) => a.data === 'invitationId' || a.data === 'memberId')
        .flatMap((a) => a.pipes);
    expect(pipesOf('getInvitationLink')).toContain(ParseUUIDPipe);
    expect(pipesOf('restoreMember')).toContain(ParseUUIDPipe);
  });
});

describe('WorkspaceMembersService.getInvitationLink', () => {
  const future = new Date(Date.now() + 86_400_000);

  it('answers the email’s accept URL and expiry for a pending invitation of this workspace', async () => {
    const findFirst = jest
      .fn()
      .mockResolvedValue({ token: 'tok123', expiresAt: future });
    const svc = makeService({ query: { workspaceInvitation: { findFirst } } });

    await expect(svc.getInvitationLink(WS, 'inv1')).resolves.toEqual({
      url: 'https://app.schedura.ai/invite/accept?token=tok123',
      expiresAt: future,
    });
    const q = whereOf(findFirst.mock.calls[0][0]);
    expect(q.params).toEqual(expect.arrayContaining([WS, 'inv1', 'PENDING']));
    expect(q.sql).toContain('"workspace_id"');
  });

  it('404s an invitation that is not pending in this workspace', async () => {
    const svc = makeService({
      query: {
        workspaceInvitation: {
          findFirst: jest.fn().mockResolvedValue(undefined),
        },
      },
    });
    await expect(svc.getInvitationLink(WS, 'other')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('404s an expired one, even while it still reads PENDING', async () => {
    const svc = makeService({
      query: {
        workspaceInvitation: {
          findFirst: jest.fn().mockResolvedValue({
            token: 'tok',
            expiresAt: new Date(Date.now() - 1000),
          }),
        },
      },
    });
    await expect(svc.getInvitationLink(WS, 'inv1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('no response carries the invitation token', () => {
  it('the pending list and the member list leave the column out', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const svc = makeService({
      query: {
        workspace: {
          findFirst: jest.fn().mockResolvedValue({ id: WS, ownerId: ADMIN }),
        },
        users: { findFirst: jest.fn().mockResolvedValue({ id: ADMIN }) },
        workspaceInvitation: { findFirst: jest.fn(), findMany },
      },
    });
    await svc.getPendingInvitations(WS, ADMIN);
    await svc.getMembers(WS, ADMIN);
    expect(findMany.mock.calls[0][0].columns).toEqual({ token: false });
    expect(findMany.mock.calls[1][0].columns).toEqual({ token: false });
  });

  it('a role change and an accept answer the row without it', async () => {
    const row = {
      id: 'm1',
      role: 'ADMIN',
      token: 'secret',
      status: 'ACCEPTED',
    };
    const { update } = updateChain([row]);
    const svc = makeService({
      query: {
        workspace: {
          findFirst: jest.fn().mockResolvedValue({ id: WS, ownerId: ADMIN }),
        },
        workspaceInvitation: { findFirst: jest.fn().mockResolvedValue(row) },
      },
      update,
    });
    const updated = await svc.updateMemberRole(
      WS,
      'm1',
      { role: 'ADMIN' } as any,
      ADMIN,
    );
    expect(updated).toEqual({ id: 'm1', role: 'ADMIN', status: 'ACCEPTED' });
    expect(JSON.stringify(updated)).not.toContain('secret');
  });

  it('batch results name each new invitation instead', async () => {
    const svc = makeService(
      {
        query: {
          workspace: {
            findFirst: jest
              .fn()
              .mockResolvedValue({ id: WS, ownerId: ADMIN, name: 'Acme' }),
          },
          users: { findFirst: jest.fn().mockResolvedValue(undefined) },
          workspaceInvitation: {
            findFirst: jest.fn().mockResolvedValue(undefined),
            findMany: jest.fn().mockResolvedValue([]),
          },
        },
        insert: () => ({
          values: () => ({
            returning: () =>
              Promise.resolve([
                {
                  id: 'inv-new',
                  email: 'sana@x.pk',
                  role: 'MEMBER',
                  token: 'secret',
                  expiresAt: new Date(),
                },
              ]),
          }),
        }),
      },
      {
        usage: {
          getWorkspaceUsage: jest
            .fn()
            .mockResolvedValue({ membersLimit: 5, membersCount: 1 }),
          enforceMemberLimit: jest.fn().mockResolvedValue(undefined),
        },
      },
    );
    const res = await svc.batchInvite(
      WS,
      [{ email: 'sana@x.pk', role: 'MEMBER' }],
      ADMIN,
    );
    expect(res.results).toEqual([
      { email: 'sana@x.pk', status: 'invited', invitationId: 'inv-new' },
    ]);
    expect(JSON.stringify(res)).not.toContain('secret');
  });
});

describe('WorkspaceMembersService.removeMember (soft)', () => {
  function removalDb(updated: unknown[]) {
    const { update, calls } = updateChain(updated);
    const del = jest.fn();
    const db: any = {
      query: {
        workspace: {
          findFirst: jest.fn().mockResolvedValue({ id: WS, ownerId: ADMIN }),
        },
        workspaceInvitation: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'm1',
            userId: MEMBER_USER,
            status: 'ACCEPTED',
          }),
        },
      },
      update,
      delete: del,
    };
    return { db, calls, del };
  }

  it('marks the row REMOVED by whom and when, and never deletes it', async () => {
    const { db, calls, del } = removalDb([{ id: 'm1' }]);
    const usage = { decrementMemberCount: jest.fn() };
    const svc = makeService(db, { usage });

    await svc.removeMember(WS, 'm1', ADMIN);

    expect(del).not.toHaveBeenCalled();
    expect(calls[0].set).toMatchObject({
      status: 'REMOVED',
      removedBy: ADMIN,
      removedAt: expect.any(Date),
    });
    // The old accept link dies: a fresh token nobody was ever sent.
    expect(calls[0].set.token).toMatch(/^[0-9a-f]{64}$/);
    // Only an ACCEPTED row is removed, so a repeat cannot decrement twice.
    expect(dialect.sqlToQuery(calls[0].where).params).toContain('ACCEPTED');
    expect(usage.decrementMemberCount).toHaveBeenCalledWith(
      WS,
      ADMIN,
      MEMBER_USER,
    );
  });

  it('a removal that lost the race to another is a 404 and counts nothing', async () => {
    const { db } = removalDb([]);
    const usage = { decrementMemberCount: jest.fn() };
    const mail = makeMail();
    await expect(
      makeService(db, { usage, mail }).removeMember(WS, 'm1', ADMIN),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(usage.decrementMemberCount).not.toHaveBeenCalled();
    // The removal that won sends the email; the loser sends nothing.
    expect(mail.notify.notify).not.toHaveBeenCalled();
  });
});

describe('a REMOVED row grants no access', () => {
  it('the role every guard reads comes from ACCEPTED rows only', async () => {
    const findFirst = jest.fn().mockResolvedValue(undefined);
    const svc = new WorkspaceRoleService({
      query: {
        workspace: {
          findFirst: jest.fn().mockResolvedValue({ id: WS, ownerId: ADMIN }),
        },
        workspaceInvitation: { findFirst },
      },
    } as any);
    await expect(svc.getRole(WS, MEMBER_USER)).resolves.toBeNull();
    const q = whereOf(findFirst.mock.calls[0][0]);
    expect(q.params).toEqual([WS, MEMBER_USER, 'ACCEPTED']);
  });
});

describe('WorkspaceMembersService.restoreMember', () => {
  const removedRow = (over: Record<string, unknown> = {}) => ({
    id: 'm1',
    workspaceId: WS,
    userId: MEMBER_USER,
    email: 'Sana@X.pk',
    role: 'ADMIN',
    status: 'REMOVED',
    token: 'secret',
    removedBy: ADMIN,
    removedAt: new Date(Date.now() - 60_000),
    ...over,
  });

  function restoreDb(
    row: unknown,
    opts: {
      alreadyMember?: boolean;
      pending?: { email: string }[];
      dropped?: unknown[];
    } = {},
  ) {
    const restored = { ...(row as object), status: 'ACCEPTED' };
    const { update, calls } = updateChain([restored]);
    const deleted: any[] = [];
    const db: any = {
      query: {
        workspace: {
          findFirst: jest.fn().mockResolvedValue({ id: WS, ownerId: OWNER }),
        },
        workspaceInvitation: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce(row)
            .mockResolvedValue(opts.alreadyMember ? { id: 'm2' } : undefined),
          findMany: jest.fn().mockResolvedValue(opts.pending ?? []),
        },
      },
      update,
      delete: jest.fn(() => ({
        where: (w: any) => {
          deleted.push(w);
          return { returning: () => Promise.resolve(opts.dropped ?? []) };
        },
      })),
    };
    return { db, calls, deleted };
  }

  const usageWith = (membersLimit: number, membersCount: number) => ({
    getWorkspaceUsage: jest
      .fn()
      .mockResolvedValue({ membersLimit, membersCount }),
    incrementMemberCount: jest.fn().mockResolvedValue(undefined),
  });

  beforeEach(() => roleService.isPlatformSuperAdmin.mockResolvedValue(false));

  it('brings the member back ACCEPTED with the same role and counts the seat', async () => {
    const { db, calls } = restoreDb(removedRow());
    const usage = usageWith(5, 1);
    const res = await makeService(db, { usage }).restoreMember(WS, 'm1', ADMIN);

    expect(calls[0].set).toEqual({
      status: 'ACCEPTED',
      removedAt: null,
      removedBy: null,
      updatedAt: expect.any(Date),
    });
    expect(calls[0].set.role).toBeUndefined();
    expect(res.member).toMatchObject({
      id: 'm1',
      role: 'ADMIN',
      status: 'ACCEPTED',
    });
    expect(res.droppedInvitations).toEqual([]);
    expect(JSON.stringify(res)).not.toContain('secret');
    expect(usage.incrementMemberCount).toHaveBeenCalledWith(
      WS,
      ADMIN,
      MEMBER_USER,
    );
    // Conditional on REMOVED, the window, and nobody with this user or
    // address ACCEPTED meanwhile: a double click or a racing accept counts once.
    const where = dialect.sqlToQuery(calls[0].where);
    expect(where.params).toEqual(
      expect.arrayContaining(['REMOVED', WS, MEMBER_USER, 'sana@x.pk']),
    );
    expect(where.sql).toContain('NOT EXISTS');
    expect(where.sql).toContain("other.status = 'ACCEPTED'");
  });

  it('checks the seat and restores under the workspace seat lock', async () => {
    const { db } = restoreDb(removedRow());
    const usage = usageWith(5, 1);
    await makeService(db, { usage }).restoreMember(WS, 'm1', ADMIN);

    expect(executed(db)[0]).toContain('pg_advisory_xact_lock');
    expect(dialect.sqlToQuery(db.execute.mock.calls[0][0]).params).toEqual([
      WS,
    ]);
    // The lock comes before the seat is read.
    expect(db.execute.mock.invocationCallOrder[0]).toBeLessThan(
      usage.getWorkspaceUsage.mock.invocationCallOrder[0],
    );
  });

  it('only the remover, the owner or a platform super admin may undo', async () => {
    const other = restoreDb(removedRow());
    const err = await makeService(other.db)
      .restoreMember(WS, 'm1', OTHER_ADMIN)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(other.calls).toHaveLength(0);

    const byOwner = restoreDb(removedRow());
    await expect(
      makeService(byOwner.db).restoreMember(WS, 'm1', OWNER),
    ).resolves.toMatchObject({ message: 'Member restored' });

    roleService.isPlatformSuperAdmin.mockResolvedValue(true);
    const bySupport = restoreDb(removedRow());
    await expect(
      makeService(bySupport.db).restoreMember(WS, 'm1', OTHER_ADMIN),
    ).resolves.toMatchObject({ message: 'Member restored' });
  });

  it('refuses after the 15-minute window: 409 RESTORE_WINDOW_PASSED', async () => {
    const { db, calls } = restoreDb(
      removedRow({
        removedAt: new Date(Date.now() - MEMBER_RESTORE_WINDOW_MS - 1),
      }),
    );
    const err = await makeService(db)
      .restoreMember(WS, 'm1', ADMIN)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'RESTORE_WINDOW_PASSED' });
    expect(calls).toHaveLength(0);
    expect(MEMBER_RESTORE_WINDOW_MS).toBe(15 * 60 * 1000);
  });

  it('refuses when every seat is taken: 409 SEAT_LIMIT_EXCEEDED', async () => {
    const { db, calls } = restoreDb(removedRow(), {
      pending: [{ email: 'other@x.pk' }],
    });
    const usage = usageWith(2, 1); // 1 member + 1 pending = full
    const err = await makeService(db, { usage })
      .restoreMember(WS, 'm1', ADMIN)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'SEAT_LIMIT_EXCEEDED' });
    expect(calls).toHaveLength(0);
    expect(usage.incrementMemberCount).not.toHaveBeenCalled();
  });

  it('a pending re-invitation to them, whatever its role, is dropped and reported', async () => {
    const reinvite = { id: 'inv-9', email: 'sana@x.pk', role: 'GUEST' };
    const { db, calls, deleted } = restoreDb(removedRow(), {
      pending: [{ email: 'sana@x.pk' }],
      dropped: [reinvite],
    });
    // It does not hold a seat against the restore: 1 member + it = 2 = limit.
    const res = await makeService(db, { usage: usageWith(2, 1) }).restoreMember(
      WS,
      'm1',
      ADMIN,
    );
    expect(calls).toHaveLength(1);
    const q = dialect.sqlToQuery(deleted[0]);
    expect(q.params).toEqual(
      expect.arrayContaining([WS, 'PENDING', 'sana@x.pk']),
    );
    // Deliberate: the restored membership (role ADMIN) replaces the GUEST re-invite.
    expect(res.member).toMatchObject({ role: 'ADMIN' });
    expect(res.droppedInvitations).toEqual([reinvite]);
  });

  it('leaving on your own is not restorable: 404', async () => {
    const { db } = restoreDb(removedRow({ removedBy: MEMBER_USER }));
    await expect(
      makeService(db).restoreMember(WS, 'm1', OWNER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s a row that is not REMOVED in this workspace', async () => {
    const { db } = restoreDb(undefined);
    await expect(
      makeService(db).restoreMember(WS, 'm1', ADMIN),
    ).rejects.toBeInstanceOf(NotFoundException);
    const q = whereOf(db.query.workspaceInvitation.findFirst.mock.calls[0][0]);
    expect(q.params).toEqual([WS, 'm1', 'REMOVED']);
  });

  it('someone re-invited and back already: 409 ALREADY_MEMBER', async () => {
    const { db, calls } = restoreDb(removedRow(), { alreadyMember: true });
    const err = await makeService(db)
      .restoreMember(WS, 'm1', ADMIN)
      .catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'ALREADY_MEMBER' });
    expect(calls).toHaveLength(0);
  });

  it('a restore that lost the race (already restored, window just closed) is a 409 and counts nothing', async () => {
    const { db } = restoreDb(removedRow());
    db.update = updateChain([]).update;
    const usage = usageWith(5, 1);
    const err = await makeService(db, { usage })
      .restoreMember(WS, 'm1', ADMIN)
      .catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'RESTORE_WINDOW_PASSED' });
    expect(usage.incrementMemberCount).not.toHaveBeenCalled();
  });

  it('a restore that lost to an accept of a re-invite is ALREADY_MEMBER and counts nothing', async () => {
    const { db } = restoreDb(removedRow());
    db.update = updateChain([]).update;
    // Not a member at the first check, accepted by the time the update ran.
    db.query.workspaceInvitation.findFirst = jest
      .fn()
      .mockResolvedValueOnce(removedRow())
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: 'm2' });
    const usage = usageWith(5, 1);
    const err = await makeService(db, { usage })
      .restoreMember(WS, 'm1', ADMIN)
      .catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'ALREADY_MEMBER' });
    expect(usage.incrementMemberCount).not.toHaveBeenCalled();
  });
});

describe('the seat lock on invites and accepts', () => {
  function inviteDb() {
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
          findMany: jest.fn().mockResolvedValue([]),
        },
      },
      insert,
    } as any;
  }

  it('a single invite checks the seat under the lock and refuses the last one taken', async () => {
    const db = inviteDb();
    const mail = makeMail();
    const usage = {
      getWorkspaceUsage: jest
        .fn()
        .mockResolvedValue({ membersLimit: 2, membersCount: 2 }),
    };
    await expect(
      makeService(db, { usage, mail }).inviteMember(
        WS,
        { email: 'a@x.pk', role: 'MEMBER' } as any,
        OWNER,
      ),
    ).rejects.toThrow(/SEAT_LIMIT_EXCEEDED/);
    expect(executed(db)[0]).toContain('pg_advisory_xact_lock');
    expect(db.insert).not.toHaveBeenCalled();
    expect(mail.outbox.sendNow).not.toHaveBeenCalled();
  });

  it('a batch invite takes the lock once, before the seat check, and emails after', async () => {
    const db = inviteDb();
    const mail = makeMail();
    const usage = {
      getWorkspaceUsage: jest
        .fn()
        .mockResolvedValue({ membersLimit: 5, membersCount: 1 }),
    };
    const res = await makeService(db, { usage, mail }).batchInvite(
      WS,
      [
        { email: 'a@x.pk', role: 'MEMBER' },
        { email: 'b@x.pk', role: 'GUEST' },
      ],
      OWNER,
    );
    expect(res.results.map((r) => r.invitationId)).toEqual([
      'inv-a@x.pk',
      'inv-b@x.pk',
    ]);
    expect(executed(db)).toHaveLength(1);
    expect(db.execute.mock.invocationCallOrder[0]).toBeLessThan(
      usage.getWorkspaceUsage.mock.invocationCallOrder[0],
    );
    expect(mail.outbox.sendNow).toHaveBeenCalledTimes(2);
  });

  it('an accept only turns a still-PENDING row ACCEPTED, under the lock', async () => {
    const updates = updateChain([]);
    const db: any = {
      query: {
        workspaceInvitation: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce({
              id: 'inv1',
              workspaceId: WS,
              status: 'PENDING',
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
      update: updates.update,
    };
    const usage = { incrementMemberCount: jest.fn() };
    // The row was taken meanwhile (a restore dropped it): refused, not counted.
    await expect(
      makeService(db, { usage }).acceptInvitation('tok', MEMBER_USER),
    ).rejects.toThrow('no longer pending');
    expect(executed(db)[0]).toContain('pg_advisory_xact_lock');
    expect(dialect.sqlToQuery(updates.calls[0].where).params).toEqual([
      'inv1',
      'PENDING',
    ]);
    expect(usage.incrementMemberCount).not.toHaveBeenCalled();
  });
});

describe('cancelInvitation cannot reach a member row', () => {
  it('looks only at invitation states, so a REMOVED (or ACCEPTED) row is a 404', async () => {
    const findFirst = jest.fn().mockResolvedValue(undefined);
    const del = jest.fn();
    const svc = makeService({
      query: { workspaceInvitation: { findFirst } },
      delete: del,
    });
    await expect(svc.cancelInvitation(WS, 'm1', ADMIN)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const q = whereOf(findFirst.mock.calls[0][0]);
    expect(q.params).toEqual(['m1', WS, 'PENDING', 'REJECTED', 'EXPIRED']);
    expect(del).not.toHaveBeenCalled();
  });
});
