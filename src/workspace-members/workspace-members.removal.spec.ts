import 'reflect-metadata';
import {
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  ParseUUIDPipe,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { AppLinks } from 'src/email/links/app-links';
import {
  MEMBER_RESTORE_WINDOW_MS,
  WorkspaceMembersService,
} from './workspace-members.service';
import { WorkspaceMembersController } from './workspace-members.controller';
import type { UpdateMemberDto } from './dto/update-member.dto';
import { REQUIRE_CAPABILITY } from './require-capability.decorator';
import { WorkspaceRoleService } from './workspace-role.service';
import { AnalyticsEventEmitter } from 'src/realtime/analytics-event-emitter.service';

// The account-live lock (FOR KEY SHARE on users) is proven against Postgres
// in workspace.create-vs-delete.db.spec.ts; these fakes have no `select`.
jest.mock('src/users/account-live', () => ({
  lockLiveAccount: jest.fn().mockResolvedValue(undefined),
}));

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
  db.execute.mock.calls.map((c: any[]) => dialect.sqlToQuery(c[0]).sql);

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

function makeService(
  db: any,
  over: {
    usage?: any;
    mail?: Mail;
    realtime?: Partial<AnalyticsEventEmitter>;
  } = {},
) {
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
    over.realtime as AnalyticsEventEmitter | undefined,
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

    await expect(svc.getInvitationLink(WS, 'inv1', ADMIN)).resolves.toEqual({
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
    await expect(
      svc.getInvitationLink(WS, 'other', ADMIN),
    ).rejects.toBeInstanceOf(NotFoundException);
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
    await expect(
      svc.getInvitationLink(WS, 'inv1', ADMIN),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('no response carries the invitation token', () => {
  it('the pending list and the member list leave the column out', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const svc = makeService({
      // getMembers' newest-session read (none here).
      select: () => {
        const b: Record<string, unknown> = {};
        b.from = () => b;
        b.where = () => b;
        b.groupBy = () => Promise.resolve([]);
        return b;
      },
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

describe('a removed member leaves the live room of the workspace', () => {
  const memberRow = { id: 'm1', userId: MEMBER_USER, status: 'ACCEPTED' };

  function db(updated: unknown[]) {
    return {
      query: {
        workspace: {
          findFirst: jest.fn().mockResolvedValue({ id: WS, ownerId: ADMIN }),
        },
        workspaceInvitation: {
          findFirst: jest.fn().mockResolvedValue(memberRow),
        },
      },
      update: updateChain(updated).update,
    };
  }
  const usage = {
    decrementMemberCount: jest.fn().mockResolvedValue(undefined),
  };

  it('removeMember calls realtime.removeUserFromWorkspace(member.userId, workspaceId) after the removal', async () => {
    const realtime = { removeUserFromWorkspace: jest.fn() };
    const dbFake = db([{ id: 'm1', role: 'MEMBER' }]);

    await makeService(dbFake, { usage, realtime }).removeMember(
      WS,
      'm1',
      ADMIN,
    );

    expect(realtime.removeUserFromWorkspace).toHaveBeenCalledTimes(1);
    expect(realtime.removeUserFromWorkspace).toHaveBeenCalledWith(
      MEMBER_USER,
      WS,
    );
  });

  it('is not called when the removal lost the race (the other removal evicts)', async () => {
    const realtime = { removeUserFromWorkspace: jest.fn() };

    await expect(
      makeService(db([]), { usage, realtime }).removeMember(WS, 'm1', ADMIN),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(realtime.removeUserFromWorkspace).not.toHaveBeenCalled();
  });

  it('is not called when the caller may not remove the member', async () => {
    const realtime = { removeUserFromWorkspace: jest.fn() };
    const dbFake = db([{ id: 'm1', role: 'MEMBER' }]);
    // The member row first; then the stranger is no admin (isUserAdmin).
    dbFake.query.workspaceInvitation.findFirst
      .mockReset()
      .mockResolvedValueOnce(memberRow)
      .mockResolvedValue(undefined);

    await expect(
      makeService(dbFake, { usage, realtime }).removeMember(
        WS,
        'm1',
        'a-stranger',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(realtime.removeUserFromWorkspace).not.toHaveBeenCalled();
  });

  it('a role change does NOT remove the user from the room', async () => {
    const realtime = { removeUserFromWorkspace: jest.fn() };
    const row = { id: 'm1', role: 'ADMIN', status: 'ACCEPTED' };
    const dbFake = db([row]);
    dbFake.query.workspaceInvitation.findFirst.mockResolvedValue(row);

    await makeService(dbFake, { usage, realtime }).updateMemberRole(
      WS,
      'm1',
      { role: 'ADMIN' } as UpdateMemberDto,
      ADMIN,
    );

    expect(realtime.removeUserFromWorkspace).not.toHaveBeenCalled();
  });

  it('the realtime layer failing does not fail the removal', async () => {
    // The real emitter around a gateway that throws: its wrapper never lets
    // the error out, so the removal that already committed still answers ok.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const realtime = new AnalyticsEventEmitter({
      removeUserFromWorkspace: () => {
        throw new Error('socket.io down');
      },
    } as never);

    await expect(
      makeService(db([{ id: 'm1', role: 'MEMBER' }]), {
        usage,
        realtime,
      }).removeMember(WS, 'm1', ADMIN),
    ).resolves.toEqual({ message: 'Member removed successfully' });
  });

  it('a spec-built service without the emitter still removes', async () => {
    await expect(
      makeService(db([{ id: 'm1', role: 'MEMBER' }]), { usage }).removeMember(
        WS,
        'm1',
        ADMIN,
      ),
    ).resolves.toEqual({ message: 'Member removed successfully' });
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
    role: 'MEMBER',
    status: 'REMOVED',
    token: 'secret',
    removedBy: ADMIN,
    removedAt: new Date(Date.now() - 60_000),
    ...over,
  });

  /** The fake restoreMember reads and writes through. */
  interface RestoreFakeDb {
    query: {
      workspace: { findFirst: jest.Mock };
      workspaceInvitation: { findFirst: jest.Mock; findMany: jest.Mock };
    };
    update: ReturnType<typeof updateChain>['update'];
    delete: jest.Mock;
    execute: jest.Mock;
  }

  function restoreDb(
    row: unknown,
    opts: {
      alreadyMember?: boolean;
      pending?: { email: string }[];
      dropped?: unknown[];
      /** A PENDING ADMIN invitation to the same address exists. */
      pendingAdminInvite?: boolean;
    } = {},
  ) {
    const restored = { ...(row as object), status: 'ACCEPTED' };
    const { update, calls } = updateChain([restored]);
    const deleted: SQL[] = [];
    const db: RestoreFakeDb = {
      query: {
        workspace: {
          findFirst: jest.fn().mockResolvedValue({ id: WS, ownerId: OWNER }),
        },
        workspaceInvitation: {
          // The first call reads the REMOVED row; the pending-ADMIN-invite
          // lookup asks for `id` only; every other call is the membership check.
          findFirst: jest
            .fn()
            .mockResolvedValueOnce(row)
            .mockImplementation((args?: { columns?: { id?: boolean } }) =>
              Promise.resolve(
                args?.columns?.id
                  ? opts.pendingAdminInvite
                    ? { id: 'inv-admin' }
                    : undefined
                  : opts.alreadyMember
                    ? { id: 'm2' }
                    : undefined,
              ),
            ),
          findMany: jest.fn().mockResolvedValue(opts.pending ?? []),
        },
      },
      update,
      execute: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn(() => ({
        where: (w: SQL) => {
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
      role: 'MEMBER',
      status: 'ACCEPTED',
    });
    expect(res.droppedInvitations).toEqual([]);
    expect(JSON.stringify(res)).not.toContain('secret');
    // The fourth argument is the transaction, and it is the point: the
    // increment has to run inside the one holding the seat lock, or the next
    // seat check reads a stale count and a rollback leaves the seat counted.
    expect(usage.incrementMemberCount).toHaveBeenCalledWith(
      WS,
      ADMIN,
      MEMBER_USER,
      expect.objectContaining({ update: expect.any(Function) }),
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

  it('restoring an ADMIN is owner-only: the ADMIN who removed them gets 403 and nothing is written', async () => {
    const t = restoreDb(removedRow({ role: 'ADMIN' }));
    const err = await makeService(t.db, { usage: usageWith(5, 1) })
      .restoreMember(WS, 'm1', ADMIN)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as Error).message).toBe(
      'Only the workspace owner can manage admins.',
    );
    expect(t.calls).toHaveLength(0);
    expect(t.db.execute).not.toHaveBeenCalled();
  });

  it('the OWNER and a platform super admin can restore an ADMIN', async () => {
    const byOwner = restoreDb(removedRow({ role: 'ADMIN' }));
    await expect(
      makeService(byOwner.db, { usage: usageWith(5, 1) }).restoreMember(
        WS,
        'm1',
        OWNER,
      ),
    ).resolves.toMatchObject({ member: { role: 'ADMIN' } });

    roleService.isPlatformSuperAdmin.mockResolvedValue(true);
    const bySupport = restoreDb(removedRow({ role: 'ADMIN' }));
    await expect(
      makeService(bySupport.db, { usage: usageWith(5, 1) }).restoreMember(
        WS,
        'm1',
        OTHER_ADMIN,
      ),
    ).resolves.toMatchObject({ member: { role: 'ADMIN' } });
  });

  it('an ADMIN who removed a MEMBER can still restore them', async () => {
    const t = restoreDb(removedRow());
    await expect(
      makeService(t.db, { usage: usageWith(5, 1) }).restoreMember(
        WS,
        'm1',
        ADMIN,
      ),
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
    // Deliberate: the restored membership (role MEMBER) replaces the GUEST re-invite.
    expect(res.member).toMatchObject({ role: 'MEMBER' });
    expect(res.droppedInvitations).toEqual([reinvite]);
  });

  describe('a pending ADMIN invitation to the same address', () => {
    it('an ADMIN restoring them gets 403 and nothing is locked or written', async () => {
      const t = restoreDb(removedRow(), { pendingAdminInvite: true });
      const err = await makeService(t.db, { usage: usageWith(5, 1) })
        .restoreMember(WS, 'm1', ADMIN)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as Error).message).toBe(
        'Only the workspace owner can manage admins.',
      );
      expect(t.calls).toHaveLength(0);
      expect(t.deleted).toHaveLength(0);
      expect(t.db.execute).not.toHaveBeenCalled();
      // The lookup is scoped to this workspace, PENDING, ADMIN and the address.
      const [asked] = t.db.query.workspaceInvitation.findFirst.mock
        .calls[1] as [{ where: SQL }];
      expect(dialect.sqlToQuery(asked.where).params).toEqual(
        expect.arrayContaining([WS, 'PENDING', 'ADMIN', 'sana@x.pk']),
      );
    });

    it('the OWNER still restores and drops it', async () => {
      const invite = { id: 'inv-admin', email: 'sana@x.pk', role: 'ADMIN' };
      const t = restoreDb(removedRow(), {
        pendingAdminInvite: true,
        dropped: [invite],
      });
      const res = await makeService(t.db, {
        usage: usageWith(5, 1),
      }).restoreMember(WS, 'm1', OWNER);
      expect(res.droppedInvitations).toEqual([invite]);
      expect(t.deleted).toHaveLength(1);
    });

    it('a platform super admin still restores and drops it', async () => {
      roleService.isPlatformSuperAdmin.mockResolvedValue(true);
      const t = restoreDb(removedRow(), { pendingAdminInvite: true });
      await expect(
        makeService(t.db, { usage: usageWith(5, 1) }).restoreMember(
          WS,
          'm1',
          ADMIN,
        ),
      ).resolves.toMatchObject({ message: 'Member restored' });
    });

    it('an ADMIN restoring them with only a MEMBER invitation pending still works', async () => {
      const invite = { id: 'inv-9', email: 'sana@x.pk', role: 'MEMBER' };
      const t = restoreDb(removedRow(), { dropped: [invite] });
      const res = await makeService(t.db, {
        usage: usageWith(5, 1),
      }).restoreMember(WS, 'm1', ADMIN);
      expect(res.droppedInvitations).toEqual([invite]);
    });
  });

  it('leaving on your own is not restorable: 404', async () => {
    const { db } = restoreDb(removedRow({ removedBy: MEMBER_USER }));
    await expect(
      makeService(db).restoreMember(WS, 'm1', OWNER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a removal whose person has since deleted their account is not restorable: 404, nothing written', async () => {
    const { db, calls } = restoreDb(
      removedRow({ user: { deletedAt: new Date() } }),
    );
    await expect(
      makeService(db).restoreMember(WS, 'm1', ADMIN),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(calls).toHaveLength(0);
    // The lookup asks for the user's deleted_at alongside the row.
    expect(
      db.query.workspaceInvitation.findFirst.mock.calls[0][0],
    ).toMatchObject({ with: { user: { columns: { deletedAt: true } } } });
  });

  it('a live account (deletedAt null) is still restorable', async () => {
    const { db, calls } = restoreDb(removedRow({ user: { deletedAt: null } }));
    await makeService(db, { usage: usageWith(5, 1) }).restoreMember(
      WS,
      'm1',
      ADMIN,
    );
    expect(calls).toHaveLength(1);
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
      .catch((e: unknown) => e);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'RESTORE_WINDOW_PASSED',
    });
    expect(usage.incrementMemberCount).not.toHaveBeenCalled();
  });

  it('a restore that lost to an accept of a re-invite is ALREADY_MEMBER and counts nothing', async () => {
    const { db } = restoreDb(removedRow());
    db.update = updateChain([]).update;
    // Not a member at the first check, accepted by the time the update ran.
    db.query.workspaceInvitation.findFirst = jest
      .fn()
      .mockResolvedValueOnce(removedRow())
      .mockResolvedValueOnce(undefined) // no pending ADMIN invitation
      .mockResolvedValueOnce(undefined) // not a member yet
      .mockResolvedValueOnce({ id: 'm2' });
    const usage = usageWith(5, 1);
    const err = await makeService(db, { usage })
      .restoreMember(WS, 'm1', ADMIN)
      .catch((e: unknown) => e);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'ALREADY_MEMBER',
    });
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

describe('only the workspace owner manages admins', () => {
  const REFUSAL = 'Only the workspace owner can manage admins.';
  const ROOT = 'root-user';
  const future = new Date(Date.now() + 86_400_000);

  /** A member row (ACCEPTED), by id. */
  const member = (id: string, role: string, userId = MEMBER_USER) => ({
    id,
    userId,
    role,
    email: `${id}@x.pk`,
    status: 'ACCEPTED',
  });
  /** An invitation row (PENDING), by id. */
  const invitation = (id: string, role: string) => ({
    id,
    role,
    email: `${id}@x.pk`,
    status: 'PENDING',
    token: 'tok',
    expiresAt: future,
    invitedBy: OWNER,
    userId: null,
  });

  /**
   * A workspace owned by OWNER where ADMIN is an ADMIN member. `rows` answers a
   * lookup by id; the "is this caller an admin" lookup is told apart by its
   * trailing 'ADMIN' param. Every write is recorded, so a refusal can be
   * proven to have written nothing.
   */
  function policyDb(rows: Record<string, any>, updateRows?: unknown[]) {
    // What any UPDATE ... RETURNING answers: enough of a row for a role
    // change, a removal and a resend alike.
    const writes = updateChain(
      updateRows ?? [
        { id: 'm1', role: 'MEMBER', status: 'PENDING', expiresAt: future },
      ],
    );
    const insert = jest.fn(() => ({
      values: (v: { email: string; role: string }) => ({
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
    const del = jest.fn(() => ({ where: () => Promise.resolve() }));
    const lookup = jest.fn((arg: unknown): Promise<unknown> => {
      const { params } = whereOf(arg);
      if (params[params.length - 1] === 'ADMIN') {
        return Promise.resolve(
          params.includes(ADMIN) ? { id: 'caller-row' } : undefined,
        );
      }
      const id = Object.keys(rows).find((k) => params.includes(k));
      return Promise.resolve(id ? rows[id] : undefined);
    });
    const db = {
      query: {
        workspace: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: WS, ownerId: OWNER, name: 'Acme' }),
        },
        users: { findFirst: jest.fn().mockResolvedValue(undefined) },
        workspaceInvitation: {
          findMany: jest.fn().mockResolvedValue([]),
          findFirst: lookup,
        },
      },
      update: writes.update,
      insert,
      delete: del,
    };
    return { db, insert, del, lookup, updates: writes.calls };
  }

  const usage = {
    getWorkspaceUsage: jest
      .fn()
      .mockResolvedValue({ membersLimit: 50, membersCount: 1 }),
    incrementMemberCount: jest.fn().mockResolvedValue(undefined),
    decrementMemberCount: jest.fn().mockResolvedValue(undefined),
  };
  const noWrite = (t: ReturnType<typeof policyDb>) => {
    expect(t.updates).toHaveLength(0);
    expect(t.insert).not.toHaveBeenCalled();
    expect(t.del).not.toHaveBeenCalled();
  };
  const refused = (p: Promise<unknown>) =>
    expect(p).rejects.toMatchObject({
      constructor: ForbiddenException,
      message: REFUSAL,
    });
  const svcOf = (t: ReturnType<typeof policyDb>) =>
    makeService(t.db, { usage, mail: makeMail() });

  beforeEach(() => {
    roleService.isPlatformSuperAdmin.mockResolvedValue(false);
    // The email paths log what these bare fakes cannot answer.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('an ADMIN cannot invite with role ADMIN (single and batch)', async () => {
    const one = policyDb({});
    await refused(
      svcOf(one).inviteMember(
        WS,
        { email: 'a@x.pk', role: 'ADMIN' } as any,
        ADMIN,
      ),
    );
    // Before the seat lock and before any write.
    expect(executed(one.db)).toHaveLength(0);
    noWrite(one);

    const batch = policyDb({});
    await refused(
      svcOf(batch).batchInvite(
        WS,
        [
          { email: 'a@x.pk', role: 'MEMBER' },
          { email: 'b@x.pk', role: 'ADMIN' },
        ],
        ADMIN,
      ),
    );
    expect(executed(batch.db)).toHaveLength(0);
    noWrite(batch);
  });

  it("an ADMIN cannot change an ADMIN's role", async () => {
    const t = policyDb({ m1: member('m1', 'ADMIN') });
    await refused(
      svcOf(t).updateMemberRole(WS, 'm1', { role: 'MEMBER' } as any, ADMIN),
    );
    expect(executed(t.db)).toHaveLength(0);
    noWrite(t);
  });

  it('an ADMIN cannot promote a MEMBER to ADMIN', async () => {
    const t = policyDb({ m1: member('m1', 'MEMBER') });
    await refused(
      svcOf(t).updateMemberRole(WS, 'm1', { role: 'ADMIN' } as any, ADMIN),
    );
    expect(executed(t.db)).toHaveLength(0);
    noWrite(t);
  });

  it('a member made ADMIN between the first read and the write is judged by the row inside the lock', async () => {
    const t = policyDb({ m1: member('m1', 'MEMBER') });
    const { lookup } = t;
    const first = lookup.getMockImplementation()!;
    // The third read is the one inside the seat lock.
    lookup.mockImplementation((arg: unknown) =>
      lookup.mock.calls.length > 2
        ? Promise.resolve(member('m1', 'ADMIN'))
        : first(arg),
    );
    await refused(
      svcOf(t).updateMemberRole(WS, 'm1', { role: 'GUEST' } as any, ADMIN),
    );
    noWrite(t);
  });

  it('an ADMIN cannot remove an ADMIN', async () => {
    const t = policyDb({ m1: member('m1', 'ADMIN') });
    await refused(svcOf(t).removeMember(WS, 'm1', ADMIN));
    noWrite(t);
  });

  it('an ADMIN removing a member who was made ADMIN since it was read: the UPDATE matches nothing and the answer is the 403', async () => {
    const t = policyDb({ m1: member('m1', 'MEMBER') }, []);
    const { lookup } = t;
    const first = lookup.getMockImplementation()!;
    // Reads: the caller's admin check, the member, then the re-read after the
    // UPDATE matched no row.
    lookup.mockImplementation((arg: unknown) =>
      lookup.mock.calls.length > 2
        ? Promise.resolve(member('m1', 'ADMIN'))
        : first(arg),
    );
    const usageSpy = { ...usage, decrementMemberCount: jest.fn() };
    await refused(
      makeService(t.db, { usage: usageSpy, mail: makeMail() }).removeMember(
        WS,
        'm1',
        ADMIN,
      ),
    );
    // The UPDATE itself carried the role guard, so it could not have removed them.
    expect(t.updates).toHaveLength(1);
    expect(dialect.sqlToQuery(t.updates[0].where).params).toContain('ADMIN');
    expect(usageSpy.decrementMemberCount).not.toHaveBeenCalled();
  });

  it('a removal that matched nothing for another reason is still a 404, for an ADMIN caller', async () => {
    const t = policyDb({ m1: member('m1', 'MEMBER') }, []);
    await expect(svcOf(t).removeMember(WS, 'm1', ADMIN)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('the owner, a super admin and a self-removal carry no role guard in the UPDATE', async () => {
    const paramsOf = async (caller: string, row: ReturnType<typeof member>) => {
      roleService.isPlatformSuperAdmin.mockResolvedValue(caller === ROOT);
      const t = policyDb({ m1: row });
      await svcOf(t).removeMember(WS, 'm1', caller);
      return dialect.sqlToQuery(t.updates[0].where).params;
    };
    expect(await paramsOf(OWNER, member('m1', 'ADMIN'))).not.toContain('ADMIN');
    expect(await paramsOf(ROOT, member('m1', 'ADMIN'))).not.toContain('ADMIN');
    expect(await paramsOf(ADMIN, member('m1', 'ADMIN', ADMIN))).not.toContain(
      'ADMIN',
    );
  });

  it('an ADMIN can still invite/change/remove MEMBER and GUEST', async () => {
    for (const role of ['MEMBER', 'GUEST'] as const) {
      const inv = policyDb({});
      await expect(
        svcOf(inv).inviteMember(WS, { email: 'a@x.pk', role } as any, ADMIN),
      ).resolves.toMatchObject({ message: 'Invitation sent successfully' });
      expect(inv.insert).toHaveBeenCalledTimes(1);

      const batch = policyDb({});
      await expect(
        svcOf(batch).batchInvite(WS, [{ email: 'a@x.pk', role }], ADMIN),
      ).resolves.toMatchObject({ results: [{ status: 'invited' }] });

      const change = policyDb({ m1: member('m1', 'MEMBER') });
      await svcOf(change).updateMemberRole(WS, 'm1', { role } as any, ADMIN);
      expect(change.updates).toHaveLength(1);

      const remove = policyDb({ m1: member('m1', role) });
      await expect(
        svcOf(remove).removeMember(WS, 'm1', ADMIN),
      ).resolves.toEqual({ message: 'Member removed successfully' });
    }
  });

  it('an ADMIN can still remove themselves (leave via removeMember isSelf)', async () => {
    const t = policyDb({ m1: member('m1', 'ADMIN', ADMIN) });
    await expect(svcOf(t).removeMember(WS, 'm1', ADMIN)).resolves.toEqual({
      message: 'Member removed successfully',
    });
    expect(t.updates).toHaveLength(1);
  });

  it('the OWNER and a super admin can do all of it', async () => {
    for (const caller of [OWNER, ROOT]) {
      roleService.isPlatformSuperAdmin.mockResolvedValue(caller === ROOT);

      const inv = policyDb({});
      await svcOf(inv).inviteMember(
        WS,
        { email: 'a@x.pk', role: 'ADMIN' } as any,
        caller,
      );
      expect(inv.insert).toHaveBeenCalledTimes(1);

      const batch = policyDb({});
      await expect(
        svcOf(batch).batchInvite(
          WS,
          [{ email: 'a@x.pk', role: 'ADMIN' }],
          caller,
        ),
      ).resolves.toMatchObject({ results: [{ status: 'invited' }] });

      const demote = policyDb({ m1: member('m1', 'ADMIN') });
      await svcOf(demote).updateMemberRole(
        WS,
        'm1',
        { role: 'MEMBER' } as any,
        caller,
      );
      expect(demote.updates).toHaveLength(1);

      const promote = policyDb({ m1: member('m1', 'MEMBER') });
      await svcOf(promote).updateMemberRole(
        WS,
        'm1',
        { role: 'ADMIN' } as any,
        caller,
      );
      expect(promote.updates).toHaveLength(1);

      const remove = policyDb({ m1: member('m1', 'ADMIN') });
      await svcOf(remove).removeMember(WS, 'm1', caller);
      expect(remove.updates).toHaveLength(1);
    }
  });

  describe('an invitation whose role is ADMIN', () => {
    const rows = () => ({
      'inv-admin': invitation('inv-admin', 'ADMIN'),
      'inv-member': invitation('inv-member', 'MEMBER'),
      'inv-guest': invitation('inv-guest', 'GUEST'),
    });

    it('an ADMIN cannot cancel, resend or copy the link of it', async () => {
      const t = policyDb(rows());
      const svc = svcOf(t);
      await refused(svc.cancelInvitation(WS, 'inv-admin', ADMIN));
      await refused(svc.resendInvitation(WS, 'inv-admin', ADMIN));
      await refused(svc.getInvitationLink(WS, 'inv-admin', ADMIN));
      noWrite(t);
    });

    it('an ADMIN still manages MEMBER and GUEST invitations', async () => {
      for (const id of ['inv-member', 'inv-guest']) {
        const t = policyDb(rows());
        const svc = svcOf(t);
        await expect(svc.getInvitationLink(WS, id, ADMIN)).resolves.toEqual({
          url: expect.stringContaining('tok') as string,
          expiresAt: future,
        });
        await expect(svc.resendInvitation(WS, id, ADMIN)).resolves.toBeTruthy();
        await expect(svc.cancelInvitation(WS, id, ADMIN)).resolves.toEqual({
          message: 'Invitation cancelled',
        });
        expect(t.del).toHaveBeenCalledTimes(1);
      }
    });

    it('the OWNER and a super admin can do all of it', async () => {
      for (const caller of [OWNER, ROOT]) {
        roleService.isPlatformSuperAdmin.mockResolvedValue(caller === ROOT);
        const t = policyDb(rows());
        const svc = svcOf(t);
        await expect(
          svc.getInvitationLink(WS, 'inv-admin', caller),
        ).resolves.toMatchObject({ expiresAt: future });
        await expect(
          svc.resendInvitation(WS, 'inv-admin', caller),
        ).resolves.toBeTruthy();
        await expect(
          svc.cancelInvitation(WS, 'inv-admin', caller),
        ).resolves.toEqual({ message: 'Invitation cancelled' });
      }
    });
  });
});
