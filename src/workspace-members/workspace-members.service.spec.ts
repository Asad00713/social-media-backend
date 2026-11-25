import {
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { PgDialect } from 'drizzle-orm/pg-core';
import { socialMediaChannels } from 'src/drizzle/schema';
import { AppLinks } from 'src/email/links/app-links';
import { MemberRole } from './dto/add-member.dto';
import type { EmailResult } from 'src/email/email.service';
import type { EnqueueEmail } from 'src/email/queue/email-job';
import type { EmailOutboxService } from 'src/email/queue/email-outbox.service';
import type { NotificationEmitterService } from 'src/notifications/notification-emitter.service';
import type {
  NotifyInput,
  NotifyService,
} from 'src/notifications/notify.service';
import { RecipientsService } from 'src/notifications/recipients.service';
import {
  MEMBER_REMOVED_EMAIL_DELAY_MS,
  MEMBER_RESTORE_WINDOW_MS,
  WorkspaceMembersService,
} from './workspace-members.service';

// The account-live lock (FOR KEY SHARE on users) is proven against Postgres
// in workspace.create-vs-delete.db.spec.ts; these fakes have no `select`.
jest.mock('src/users/account-live', () => ({
  lockLiveAccount: jest.fn().mockResolvedValue(undefined),
}));

const DAY_MS = 24 * 60 * 60 * 1000;

/** Everything the service sends or notifies through, faked. */
function makeMail() {
  const recipients = new RecipientsService(null as any);
  jest
    .spyOn(recipients, 'user')
    .mockImplementation((id: string) =>
      Promise.resolve(
        id === 'owner1'
          ? { id, email: 'rehman@lumierecafe.pk', name: 'M Rehman' }
          : id === 'user-1'
            ? { id, email: 'sana@lumierecafe.pk', name: 'Sana Noor' }
            : null,
      ),
    );
  return {
    outbox: {
      sendNow: jest
        .fn<Promise<EmailResult>, [Omit<EnqueueEmail<any>, 'delayMs'>]>()
        .mockResolvedValue({ success: true }),
    },
    notify: {
      notify: jest
        .fn<Promise<void>, [NotifyInput<any>]>()
        .mockResolvedValue(undefined),
    },
    emitter: {
      invitationAccepted: jest.fn().mockResolvedValue(undefined),
      memberRemoved: jest.fn().mockResolvedValue(undefined),
    },
    recipients,
    links: new AppLinks({ get: () => undefined } as unknown as ConfigService),
  };
}

type Mail = ReturnType<typeof makeMail>;

/**
 * The email collaborators come from `mail`: the outbox is the 3rd constructor
 * argument, then come notify, the emitter, recipients and links.
 */
function build(
  db: any,
  usageService: any,
  usersService: any,
  roleService: any,
  mail: Mail = makeMail(),
) {
  return new WorkspaceMembersService(
    db,
    usageService,
    mail.outbox as unknown as EmailOutboxService,
    usersService,
    roleService,
    mail.notify as unknown as NotifyService,
    mail.emitter as unknown as NotificationEmitterService,
    mail.recipients,
    mail.links,
  );
}

const noRole: any = {
  isPlatformSuperAdmin: jest.fn().mockResolvedValue(false),
};

// Every warning the service logs is silenced; the spy lets tests read them.
let warnSpy: jest.SpyInstance;
beforeEach(() => {
  warnSpy = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

/** The service's transactions (and savepoints) run the callback on the same mock. */
function withTx<T extends Record<string, any>>(db: T): T {
  const out: any = db;
  out.execute = jest.fn().mockResolvedValue(undefined);
  out.transaction = (fn: (tx: unknown) => unknown) => fn(out);
  return out;
}

describe('WorkspaceMembersService.inviteMember email (B1)', () => {
  function inviteDb(expiresAt: Date) {
    const invitationRow = {
      id: 'inv1',
      email: 'sana@lumierecafe.pk',
      role: 'GUEST',
      token: 'tok123',
      expiresAt,
    };
    return withTx({
      query: {
        workspace: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'ws1',
            ownerId: 'owner1',
            name: 'Rehman Workspace',
          }),
        },
        users: { findFirst: jest.fn().mockResolvedValue(undefined) },
        workspaceInvitation: {
          findFirst: jest.fn().mockResolvedValue(undefined),
          findMany: jest.fn().mockResolvedValue([]),
        },
      },
      insert: () => ({
        // The row as inserted: `userId` is the invitee's account, if any.
        values: (v: { userId: string | null }) => ({
          returning: () =>
            Promise.resolve([{ ...invitationRow, userId: v.userId }]),
        }),
      }),
      // 8 connected channels, 2 accepted members (+ the owner = 3 people).
      select: () => ({
        from: (table: unknown) => ({
          where: () =>
            Promise.resolve([{ count: table === socialMediaChannels ? 8 : 2 }]),
        }),
      }),
    });
  }

  const usage: any = {
    getWorkspaceUsage: jest
      .fn()
      .mockResolvedValue({ membersLimit: 5, membersCount: 1 }),
  };

  it('sends the invitation inline to the invitee with the accept link', async () => {
    const expiresAt = new Date(Date.now() + 7 * DAY_MS);
    const mail = makeMail();
    const service = build(inviteDb(expiresAt), usage, {}, noRole, mail);

    await service.inviteMember(
      'ws1',
      { email: ' Sana@LumiereCafe.pk ', role: 'GUEST' } as any,
      'owner1',
    );

    expect(mail.outbox.sendNow).toHaveBeenCalledTimes(1);
    const sent = mail.outbox.sendNow.mock.calls[0][0];
    expect(sent.template.id).toBe('workspace-invitation');
    expect(sent.to).toEqual({ email: 'sana@lumierecafe.pk', userId: null });
    expect(sent.workspaceId).toBe('ws1');
    expect(sent.idempotencyKey).toBe(`invite.inv1.${expiresAt.getTime()}`);
    expect(sent.props).toEqual({
      inviterName: 'M Rehman',
      inviterEmail: 'rehman@lumierecafe.pk',
      workspaceName: 'Rehman Workspace',
      role: 'GUEST',
      channels: 8,
      members: 3,
      acceptUrl: 'http://localhost:3001/invite/accept?token=tok123',
      inviteeEmail: 'sana@lumierecafe.pk',
      expiresInDays: 7,
      message: null,
    });
    // The mail carries the invite token, so it never goes through Redis.
    expect(mail.notify.notify).not.toHaveBeenCalled();
  });

  it('a rotated token is a new idempotency key', async () => {
    const first = new Date(Date.now() + 7 * DAY_MS);
    const second = new Date(first.getTime() + 1000);
    const keys: string[] = [];
    for (const expiresAt of [first, second]) {
      const mail = makeMail();
      await build(inviteDb(expiresAt), usage, {}, noRole, mail).inviteMember(
        'ws1',
        { email: 'sana@lumierecafe.pk' } as any,
        'owner1',
      );
      keys.push(mail.outbox.sendNow.mock.calls[0][0].idempotencyKey);
    }
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('still creates the invitation when the email cannot be sent', async () => {
    const mail = makeMail();
    mail.outbox.sendNow.mockResolvedValue({
      success: false,
      error: 'boom sana@lumierecafe.pk',
    });
    const service = build(
      inviteDb(new Date(Date.now() + 7 * DAY_MS)),
      usage,
      {},
      noRole,
      mail,
    );
    const res = await service.inviteMember(
      'ws1',
      { email: 'sana@lumierecafe.pk' } as any,
      'owner1',
    );
    expect(res.invitation.id).toBe('inv1');
    expect(warnSpy).toHaveBeenCalled();
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('sana@');
  });

  it('still creates the invitation when sending throws', async () => {
    const mail = makeMail();
    mail.outbox.sendNow.mockRejectedValue(new Error('redis down'));
    const service = build(
      inviteDb(new Date(Date.now() + 7 * DAY_MS)),
      usage,
      {},
      noRole,
      mail,
    );
    await expect(
      service.inviteMember(
        'ws1',
        { email: 'sana@lumierecafe.pk' } as any,
        'owner1',
      ),
    ).resolves.toMatchObject({ message: 'Invitation sent successfully' });
  });

  it('records an existing account as the recipient user', async () => {
    const mail = makeMail();
    const db = inviteDb(new Date(Date.now() + 7 * DAY_MS));
    db.query.users.findFirst = jest
      .fn()
      .mockResolvedValueOnce({ id: 'owner1', email: 'rehman@lumierecafe.pk' }) // owner
      .mockResolvedValueOnce({ id: 'user-1', email: 'sana@lumierecafe.pk' }); // invitee
    await build(db, usage, {}, noRole, mail).inviteMember(
      'ws1',
      { email: 'sana@lumierecafe.pk' } as any,
      'owner1',
    );
    expect(mail.outbox.sendNow.mock.calls[0][0].to.userId).toBe('user-1');
  });
});

describe('WorkspaceMembersService.previewInvitation', () => {
  it('returns safe fields and an expired flag', async () => {
    const past = new Date('2000-01-01T00:00:00Z');
    const db: any = {
      query: {
        workspaceInvitation: {
          findFirst: jest.fn().mockResolvedValue({
            email: 'new@acme.com',
            role: 'MEMBER',
            status: 'PENDING',
            expiresAt: past,
            workspace: { name: 'Acme' },
            inviter: { name: 'Sam' },
          }),
        },
      },
    };
    const service = build(db, {} as any, {} as any, noRole);
    const res = await service.previewInvitation('tok123');
    expect(res).toEqual({
      workspaceName: 'Acme',
      inviterName: 'Sam',
      invitedEmail: 'new@acme.com',
      role: 'MEMBER',
      status: 'PENDING',
      expired: true,
    });
    expect((res as any).token).toBeUndefined();
  });
});

describe('WorkspaceMembersService.previewInvitation and a deleted workspace', () => {
  function previewDb(workspaceRow: { name: string; deletedAt: Date | null }) {
    const findFirst = jest.fn().mockResolvedValue({
      email: 'new@acme.com',
      role: 'MEMBER',
      status: 'PENDING',
      expiresAt: new Date(Date.now() + DAY_MS),
      workspace: workspaceRow,
      inviter: { name: 'Sam' },
    });
    return { db: { query: { workspaceInvitation: { findFirst } } }, findFirst };
  }

  it('an invitation to a soft-deleted workspace is not found', async () => {
    const { db } = previewDb({ name: 'Gone Inc', deletedAt: new Date() });
    const service = build(db, {} as never, {} as never, noRole);
    await expect(service.previewInvitation('tok')).rejects.toThrow(
      new NotFoundException('Invitation not found'),
    );
  });

  it('an invitation to a live workspace still previews', async () => {
    const { db } = previewDb({ name: 'Acme', deletedAt: null });
    const service = build(db, {} as never, {} as never, noRole);
    await expect(service.previewInvitation('tok')).resolves.toMatchObject({
      workspaceName: 'Acme',
    });
  });

  it('asks the database for the workspace deletedAt, since the check depends on it', async () => {
    const { db, findFirst } = previewDb({ name: 'Acme', deletedAt: null });
    await build(db, {} as never, {} as never, noRole).previewInvitation('tok');
    const [query] = findFirst.mock.calls[0] as [
      { with: { workspace: { columns: Record<string, boolean> } } },
    ];
    expect(query.with.workspace.columns).toMatchObject({ deletedAt: true });
  });
});

describe('WorkspaceMembersService invitations and platform super admins', () => {
  const PAST_GATE = new Error('past the permission check');
  const superAdmin: any = {
    isPlatformSuperAdmin: jest.fn().mockResolvedValue(true),
  };

  /**
   * A live workspace owned by someone else; the caller is neither its owner nor
   * an admin (no ACCEPTED ADMIN row). Anything that gets past the permission
   * check reaches `transaction` / `findMany`, which is how the tests tell
   * "allowed" from "forbidden".
   */
  function dbOfOtherWorkspace() {
    return {
      query: {
        workspace: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 'ws1', ownerId: 'owner1', name: 'Acme' }),
        },
        workspaceInvitation: {
          findFirst: jest.fn().mockResolvedValue(undefined),
          findMany: jest.fn().mockResolvedValue([]),
        },
      },
      transaction: jest.fn().mockRejectedValue(PAST_GATE),
    };
  }
  const invite = { email: 'a@x.com', role: MemberRole.MEMBER };

  describe('a super admin can list pending invitations and invite', () => {
    it('inviteMember passes the permission check', async () => {
      const svc = build(
        dbOfOtherWorkspace(),
        {} as never,
        {} as never,
        superAdmin,
      );
      await expect(svc.inviteMember('ws1', invite, 'root')).rejects.toBe(
        PAST_GATE,
      );
    });

    it('batchInvite passes the permission check', async () => {
      const svc = build(
        dbOfOtherWorkspace(),
        {} as never,
        {} as never,
        superAdmin,
      );
      await expect(svc.batchInvite('ws1', [invite], 'root')).rejects.toBe(
        PAST_GATE,
      );
    });

    it('getPendingInvitations lists', async () => {
      const svc = build(
        dbOfOtherWorkspace(),
        {} as never,
        {} as never,
        superAdmin,
      );
      await expect(svc.getPendingInvitations('ws1', 'root')).resolves.toEqual(
        [],
      );
    });
  });

  describe('an admin of another workspace still cannot', () => {
    it('inviteMember is forbidden', async () => {
      const svc = build(dbOfOtherWorkspace(), {} as never, {} as never, noRole);
      await expect(
        svc.inviteMember('ws1', invite, 'other-admin'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('batchInvite is forbidden', async () => {
      const svc = build(dbOfOtherWorkspace(), {} as never, {} as never, noRole);
      await expect(
        svc.batchInvite('ws1', [invite], 'other-admin'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('getPendingInvitations is forbidden', async () => {
      const svc = build(dbOfOtherWorkspace(), {} as never, {} as never, noRole);
      await expect(
        svc.getPendingInvitations('ws1', 'other-admin'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});

describe('WorkspaceMembersService.acceptInvitation auto-verify + onboarding', () => {
  it('verifies email and stamps onboarding on successful accept', async () => {
    const invitationRow = {
      id: 'inv1',
      workspaceId: 'ws1',
      status: 'PENDING',
      email: 'invitee@acme.com',
      expiresAt: new Date('2099-01-01T00:00:00Z'),
      workspace: { id: 'ws1', name: 'Acme' },
      inviter: { id: 'owner1', name: 'Sam' },
    };
    const acceptedRow = { ...invitationRow, status: 'ACCEPTED' };
    const db: any = withTx({
      query: {
        workspaceInvitation: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce(invitationRow) // find by token
            .mockResolvedValueOnce(undefined), // existing-member check
        },
        users: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 'user-1', email: 'invitee@acme.com' }),
        },
      },
      update: () => ({
        set: () => ({
          where: () => ({ returning: () => Promise.resolve([acceptedRow]) }),
        }),
      }),
    });
    const usageService: any = {
      incrementMemberCount: jest.fn().mockResolvedValue(undefined),
    };
    const usersService: any = {
      verifyEmail: jest.fn().mockResolvedValue(undefined),
      markOnboardingCompleted: jest.fn().mockResolvedValue(undefined),
    };

    const service = build(db, usageService, usersService, noRole);
    await service.acceptInvitation('tok', 'user-1');

    expect(usersService.verifyEmail).toHaveBeenCalledWith('user-1');
    expect(usersService.markOnboardingCompleted).toHaveBeenCalledWith('user-1');
  });
});

describe('WorkspaceMembersService.batchInvite seat gate', () => {
  it('rejects the whole batch when it exceeds remaining seats', async () => {
    const db: any = withTx({
      query: {
        workspace: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 'w', ownerId: 'owner', name: 'Acme' }),
        },
        users: { findFirst: jest.fn().mockResolvedValue(undefined) },
        workspaceInvitation: {
          findFirst: jest.fn().mockResolvedValue(undefined),
          findMany: jest.fn().mockResolvedValue([]), // no pending
        },
      },
      insert: () => ({
        values: () => ({
          returning: () =>
            Promise.resolve([
              {
                id: 'i',
                email: 'x',
                role: 'MEMBER',
                token: 't',
                expiresAt: new Date(),
              },
            ]),
        }),
      }),
      // count of accepted members:
      select: () => ({
        from: () => ({ where: () => Promise.resolve([{ count: 1 }]) }),
      }),
    });
    const usageService: any = {
      getWorkspaceUsage: jest.fn().mockResolvedValue({
        membersLimit: 2,
        membersCount: 1,
        membersAvailable: 1,
      }),
    };
    const usersService: any = {};
    const svc = build(db, usageService, usersService, noRole);
    // reserved = membersCount(1) + pending(0) = 1; limit 2 → 1 seat left; batch of 2 → exceeds
    await expect(
      svc.batchInvite(
        'w',
        [
          { email: 'a@x.com', role: 'MEMBER' },
          { email: 'b@x.com', role: 'MEMBER' },
        ] as any,
        'owner',
      ),
    ).rejects.toThrow(/SEAT_LIMIT_EXCEEDED/);
  });
});

/**
 * `db.select(...).from(user_sessions).where(...).groupBy(...)`: the newest
 * session use per user that getMembers reads (R14).
 */
function sessionUseSelect(rows: { userId: string; lastUsedAt: Date }[] = []) {
  return jest.fn(() => {
    const b: Record<string, unknown> = {};
    b.from = () => b;
    b.where = () => b;
    b.groupBy = () => Promise.resolve(rows);
    return b;
  });
}

describe('WorkspaceMembersService.getMembers last seen', () => {
  it('returns lastLoginAt for the owner and every member', async () => {
    const lastLogin = new Date('2026-09-20T10:00:00Z');
    const findFirstUsers = jest.fn().mockResolvedValue({
      id: 'owner1',
      name: 'Owner',
      email: 'o@x.com',
      lastLoginAt: lastLogin,
    });
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'inv1',
        role: 'MEMBER',
        user: { id: 'u2', name: 'Sara', email: 's@x.com', lastLoginAt: null },
        inviter: { id: 'owner1', name: 'Owner' },
      },
    ]);
    const db: any = {
      select: sessionUseSelect(),
      query: {
        workspace: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 'ws1', ownerId: 'owner1' }),
        },
        users: { findFirst: findFirstUsers },
        workspaceInvitation: {
          findFirst: jest.fn().mockResolvedValue(undefined),
          findMany,
        },
      },
    };
    const service = build(db, {} as any, {} as any, {} as any);

    const result = await service.getMembers('ws1', 'owner1');

    expect(findFirstUsers.mock.calls[0][0].columns).toMatchObject({
      lastLoginAt: true,
    });
    expect(findMany.mock.calls[0][0].with.user.columns).toMatchObject({
      lastLoginAt: true,
    });
    expect(result.owner?.lastLoginAt).toEqual(lastLogin);
    expect(result.members[0].user?.lastLoginAt).toBeNull();
  });
});

describe('WorkspaceMembersService.getMembers lastActiveAt', () => {
  function membersDb(
    ownerLogin: Date | null,
    memberLogin: Date | null,
    sessions: { userId: string; lastUsedAt: Date }[] = [],
  ) {
    return {
      select: sessionUseSelect(sessions),
      query: {
        workspace: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 'ws1', ownerId: 'owner1' }),
        },
        users: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'owner1',
            name: 'Owner',
            email: 'o@x.com',
            lastLoginAt: ownerLogin,
          }),
        },
        workspaceInvitation: {
          findFirst: jest.fn().mockResolvedValue(undefined),
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'inv1',
              role: 'MEMBER',
              user: {
                id: 'u2',
                name: 'Sara',
                email: 's@x.com',
                lastLoginAt: memberLogin,
              },
              inviter: { id: 'owner1', name: 'Owner' },
            },
          ]),
        },
      },
    };
  }

  it('adds lastActiveAt (ISO) on the owner and each member, keeping the old keys', async () => {
    const ownerLogin = new Date('2026-11-16T08:30:00Z');
    const memberLogin = new Date('2026-11-01T12:00:00Z');
    const service = build(
      membersDb(ownerLogin, memberLogin),
      {} as any,
      {} as any,
      {} as any,
    );

    const res = await service.getMembers('ws1', 'owner1');

    expect(res.owner?.lastActiveAt).toBe('2026-11-16T08:30:00.000Z');
    expect(res.owner?.lastLoginAt).toEqual(ownerLogin);
    expect(res.members[0].lastActiveAt).toBe('2026-11-01T12:00:00.000Z');
    expect(res.members[0].user?.lastLoginAt).toEqual(memberLogin);
    expect(res.members[0].role).toBe('MEMBER');
    expect(res.totalMembers).toBe(2);
  });

  it('the newest session use wins over the last sign-in; no session falls back to it', async () => {
    const ownerLogin = new Date('2026-11-16T08:30:00Z');
    const memberLogin = new Date('2026-11-01T12:00:00Z');
    const service = build(
      membersDb(ownerLogin, memberLogin, [
        { userId: 'u2', lastUsedAt: new Date('2026-11-20T07:00:00Z') },
      ]),
      {} as any,
      {} as any,
      {} as any,
    );

    const res = await service.getMembers('ws1', 'owner1');

    expect(res.members[0].lastActiveAt).toBe('2026-11-20T07:00:00.000Z');
    expect(res.owner?.lastActiveAt).toBe('2026-11-16T08:30:00.000Z');
  });

  it('is null for someone who never signed in', async () => {
    const service = build(
      membersDb(null, null),
      {} as any,
      {} as any,
      {} as any,
    );
    const res = await service.getMembers('ws1', 'owner1');
    expect(res.owner?.lastActiveAt).toBeNull();
    expect(res.members[0].lastActiveAt).toBeNull();
  });
});

describe('WorkspaceMembersService.batchInvite personal message', () => {
  function batchDb(inserted: Record<string, unknown>[]) {
    return withTx({
      query: {
        workspace: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'ws1',
            ownerId: 'owner1',
            name: 'Acme',
          }),
        },
        users: { findFirst: jest.fn().mockResolvedValue(undefined) },
        workspaceInvitation: {
          findFirst: jest.fn().mockResolvedValue(undefined),
          findMany: jest.fn().mockResolvedValue([]),
        },
      },
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          inserted.push(v);
          return {
            returning: () =>
              Promise.resolve([
                {
                  id: 'inv-' + String(v.email),
                  token: 'tok',
                  expiresAt: new Date(Date.now() + 7 * DAY_MS),
                  userId: null,
                  ...v,
                },
              ]),
          };
        },
      }),
      select: () => ({
        from: () => ({ where: () => Promise.resolve([{ count: 0 }]) }),
      }),
    });
  }
  const usage: any = {
    getWorkspaceUsage: jest
      .fn()
      .mockResolvedValue({ membersLimit: 5, membersCount: 1 }),
  };
  const invites = [
    { email: 'a@x.pk', role: 'MEMBER' as const },
    { email: 'b@x.pk', role: 'GUEST' as const },
  ];

  it('stores the note on every row and puts it in every email', async () => {
    const inserted: Record<string, unknown>[] = [];
    const mail = makeMail();
    await build(batchDb(inserted), usage, {}, noRole, mail).batchInvite(
      'ws1',
      invites,
      'owner1',
      'Welcome aboard, see the October plan.',
    );
    expect(inserted.map((v) => v.message)).toEqual([
      'Welcome aboard, see the October plan.',
      'Welcome aboard, see the October plan.',
    ]);
    expect(mail.outbox.sendNow).toHaveBeenCalledTimes(2);
    for (const [sent] of mail.outbox.sendNow.mock.calls) {
      expect((sent.props as { message: string | null }).message).toBe(
        'Welcome aboard, see the October plan.',
      );
    }
  });

  it('no note is null on the row and in the email', async () => {
    const inserted: Record<string, unknown>[] = [];
    const mail = makeMail();
    await build(batchDb(inserted), usage, {}, noRole, mail).batchInvite(
      'ws1',
      invites,
      'owner1',
    );
    expect(inserted.map((v) => v.message)).toEqual([null, null]);
    expect(
      (mail.outbox.sendNow.mock.calls[0][0].props as { message: unknown })
        .message,
    ).toBeNull();
  });
});

describe('WorkspaceMembersService.getPendingInvitations view', () => {
  it('lists PENDING and EXPIRED rows, computes the status, never selects the token', async () => {
    const now = Date.now();
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'live',
        status: 'PENDING',
        expiresAt: new Date(now + 2 * DAY_MS),
        message: 'hi',
        inviter: { id: 'o', name: 'Rehman', email: 'r@x.pk' },
      },
      {
        id: 'lapsed',
        status: 'PENDING',
        expiresAt: new Date(now - 3 * DAY_MS),
        message: null,
        inviter: { id: 'o', name: 'Rehman', email: 'r@x.pk' },
      },
      {
        id: 'stored',
        status: 'EXPIRED',
        expiresAt: new Date(now - 5 * DAY_MS),
        message: null,
        inviter: null,
        token: 'leak',
      },
    ]);
    const db: any = {
      query: {
        workspace: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 'ws1', ownerId: 'owner1' }),
        },
        // isUserAdmin: the owner is asked first and never needs this answer.
        workspaceInvitation: {
          findFirst: jest.fn().mockResolvedValue(undefined),
          findMany,
        },
      },
    };
    const res = await build(
      db,
      {} as any,
      {} as any,
      noRole,
    ).getPendingInvitations('ws1', 'owner1');

    expect(findMany.mock.calls[0][0].columns).toEqual({ token: false });
    expect(res.map((r) => [r.id, r.status, r.invitedByName])).toEqual([
      ['live', 'PENDING', 'Rehman'],
      ['lapsed', 'EXPIRED', 'Rehman'],
      ['stored', 'EXPIRED', null],
    ]);
    expect(res[0].message).toBe('hi');
    expect(JSON.stringify(res)).not.toContain('leak');
  });
});

describe('WorkspaceMembersService.resendInvitation', () => {
  const DAYS_7 = 7 * DAY_MS;

  function resendDb(
    row: Record<string, unknown> | undefined,
    opts: { sibling?: boolean; ownerEmail?: string; member?: boolean } = {},
  ) {
    const set = jest.fn();
    const db: any = withTx({
      query: {
        workspace: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 'ws1', ownerId: 'owner1', name: 'Acme' }),
        },
        // 1st call: the workspace owner; 2nd: the account behind the address.
        users: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce({
              id: 'owner1',
              email: opts.ownerEmail ?? 'rehman@lumierecafe.pk',
            })
            .mockResolvedValueOnce(
              opts.member
                ? { id: 'user-9', email: 'sana@lumierecafe.pk' }
                : undefined,
            )
            .mockResolvedValue(undefined),
        },
        workspaceInvitation: {
          // 1st call: the row; then (an account exists) its ACCEPTED row;
          // then a sibling PENDING invite; last, the view.
          findFirst: [
            row,
            // Only asked when an account exists behind the address.
            ...(opts.member ? [{ id: 'acc-1' }] : []),
            opts.sibling ? { id: 'other' } : undefined,
          ].reduce(
            (fn, value) => fn.mockResolvedValueOnce(value),
            jest.fn().mockResolvedValue(undefined),
          ),
          findMany: jest.fn().mockResolvedValue([]),
        },
      },
      // The email's channel and member counts.
      select: () => ({
        from: () => ({ where: () => Promise.resolve([{ count: 2 }]) }),
      }),
      update: () => ({
        set: (v: Record<string, unknown>) => {
          set(v);
          return {
            where: () => ({
              returning: () => Promise.resolve([{ ...row, ...v }]),
            }),
          };
        },
      }),
    });
    return { db, set };
  }

  const base = {
    id: 'inv1',
    workspaceId: 'ws1',
    email: 'Sana@LumiereCafe.pk',
    role: 'MEMBER',
    token: 'tok-1',
    invitedBy: 'owner1',
    userId: null,
    message: 'See you inside',
  };
  const usageWith = (membersLimit: number, membersCount: number): any => ({
    getWorkspaceUsage: jest
      .fn()
      .mockResolvedValue({ membersLimit, membersCount }),
  });

  it('a live PENDING invite gets 7 more days and the email again, no seat check', async () => {
    const { db, set } = resendDb({
      ...base,
      status: 'PENDING',
      expiresAt: new Date(Date.now() + DAY_MS),
    });
    const usage = usageWith(1, 1); // no free seat: must not matter
    const mail = makeMail();

    const res = await build(db, usage, {}, noRole, mail).resendInvitation(
      'ws1',
      'inv1',
      'owner1',
    );

    expect(usage.getWorkspaceUsage).not.toHaveBeenCalled();
    const patch = set.mock.calls[0][0] as { status: string; expiresAt: Date };
    expect(patch.status).toBe('PENDING');
    expect(
      Math.abs(patch.expiresAt.getTime() - (Date.now() + DAYS_7)),
    ).toBeLessThan(5_000);
    expect(patch).not.toHaveProperty('token');
    expect(res.status).toBe('PENDING');
    expect(JSON.stringify(res)).not.toContain('tok-1');

    const sent = mail.outbox.sendNow.mock.calls[0][0];
    expect(sent.idempotencyKey).toBe(
      `invite.inv1.${patch.expiresAt.getTime()}`,
    );
    expect(sent.props).toMatchObject({
      acceptUrl: expect.stringContaining('tok-1'),
      message: 'See you inside',
    });
  });

  it('an EXPIRED invite with no free seat is 403 SEAT_LIMIT_EXCEEDED and nothing is written', async () => {
    const { db, set } = resendDb({
      ...base,
      status: 'EXPIRED',
      expiresAt: new Date(Date.now() - 2 * DAY_MS),
    });
    const mail = makeMail();
    await expect(
      build(db, usageWith(2, 2), {}, noRole, mail).resendInvitation(
        'ws1',
        'inv1',
        'owner1',
      ),
    ).rejects.toThrow(/SEAT_LIMIT_EXCEEDED/);
    expect(set).not.toHaveBeenCalled();
    expect(mail.outbox.sendNow).not.toHaveBeenCalled();
    // The seat check ran under the workspace's seat lock.
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it('an EXPIRED invite with a free seat turns PENDING again', async () => {
    const { db, set } = resendDb({
      ...base,
      status: 'EXPIRED',
      expiresAt: new Date(Date.now() - 2 * DAY_MS),
    });
    const res = await build(db, usageWith(3, 2), {}, noRole).resendInvitation(
      'ws1',
      'inv1',
      'owner1',
    );
    expect((set.mock.calls[0][0] as { status: string }).status).toBe('PENDING');
    expect(res.status).toBe('PENDING');
  });

  it('a PENDING row already past its expiry is checked like an expired one', async () => {
    const { db, set } = resendDb({
      ...base,
      status: 'PENDING',
      expiresAt: new Date(Date.now() - DAY_MS),
    });
    await expect(
      build(db, usageWith(1, 1), {}, noRole).resendInvitation(
        'ws1',
        'inv1',
        'owner1',
      ),
    ).rejects.toThrow(/SEAT_LIMIT_EXCEEDED/);
    expect(set).not.toHaveBeenCalled();
  });

  it('the workspace owner is 409 and nothing is written', async () => {
    const { db, set } = resendDb(
      {
        ...base,
        status: 'EXPIRED',
        expiresAt: new Date(Date.now() - DAY_MS),
      },
      { ownerEmail: ' SANA@lumierecafe.pk ' },
    );
    const mail = makeMail();
    const err = await build(db, usageWith(5, 1), {}, noRole, mail)
      .resendInvitation('ws1', 'inv1', 'owner1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).message).toBe(
      'User is already the workspace owner',
    );
    expect(set).not.toHaveBeenCalled();
    expect(mail.outbox.sendNow).not.toHaveBeenCalled();
  });

  it('someone who has since joined is 409 and nothing is written', async () => {
    const { db, set } = resendDb(
      {
        ...base,
        status: 'PENDING',
        expiresAt: new Date(Date.now() - DAY_MS),
      },
      { member: true },
    );
    const mail = makeMail();
    const err = await build(db, usageWith(5, 1), {}, noRole, mail)
      .resendInvitation('ws1', 'inv1', 'owner1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).message).toBe(
      'User is already a member of this workspace',
    );
    expect(set).not.toHaveBeenCalled();
    expect(mail.outbox.sendNow).not.toHaveBeenCalled();
  });

  it('another live invite to the same address is 409 INVITATION_ALREADY_PENDING', async () => {
    const { db, set } = resendDb(
      {
        ...base,
        status: 'EXPIRED',
        expiresAt: new Date(Date.now() - DAY_MS),
      },
      { sibling: true },
    );
    const err = await build(db, usageWith(5, 1), {}, noRole)
      .resendInvitation('ws1', 'inv1', 'owner1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'INVITATION_ALREADY_PENDING',
    });
    expect(set).not.toHaveBeenCalled();
  });

  it.each(['ACCEPTED', 'REMOVED', 'REJECTED'])(
    'a %s row is 409 INVITATION_NOT_RESENDABLE',
    async (status) => {
      const { db, set } = resendDb({
        ...base,
        status,
        expiresAt: new Date(Date.now() + DAY_MS),
      });
      const err = await build(db, usageWith(5, 1), {}, noRole)
        .resendInvitation('ws1', 'inv1', 'owner1')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        statusCode: 409,
        code: 'INVITATION_NOT_RESENDABLE',
      });
      expect(set).not.toHaveBeenCalled();
    },
  );

  it('an unknown invitation is a 404', async () => {
    const { db } = resendDb(undefined);
    await expect(
      build(db, usageWith(5, 1), {}, noRole).resendInvitation(
        'ws1',
        'nope',
        'owner1',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('WorkspaceMembersService.inviteMember email case', () => {
  it('matches users and invitations case-insensitively and stores lowercase', async () => {
    const dialect = new PgDialect();
    const userFind = jest
      .fn()
      .mockImplementation(async (arg: any) =>
        dialect.sqlToQuery(arg.where).sql.includes('"users"."id" =')
          ? { id: 'owner1', email: 'Owner@Acme.com' }
          : undefined,
      );
    const invFind = jest.fn().mockResolvedValue(undefined);
    const values = jest.fn().mockReturnValue({
      returning: () =>
        Promise.resolve([
          {
            id: 'i',
            email: 'sara@x.com',
            role: 'MEMBER',
            token: 't',
            expiresAt: new Date(),
          },
        ]),
    });
    const db: any = withTx({
      query: {
        workspace: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 'ws1', ownerId: 'owner1', name: 'A' }),
        },
        users: { findFirst: userFind },
        workspaceInvitation: {
          findFirst: invFind,
          findMany: jest.fn().mockResolvedValue([]),
        },
      },
      insert: () => ({ values }),
    });
    const service = build(
      db,
      {
        getWorkspaceUsage: jest
          .fn()
          .mockResolvedValue({ membersLimit: 5, membersCount: 1 }),
      } as any,
      {} as any,
      noRole,
    );

    await service.inviteMember(
      'ws1',
      { email: ' Sara@X.com ', role: 'MEMBER' } as any,
      'owner1',
    );

    const emailLookup = dialect.sqlToQuery(userFind.mock.calls[1][0].where);
    expect(emailLookup.sql).toContain('lower("users"."email")');
    expect(emailLookup.params).toEqual(['sara@x.com']);
    const invLookup = dialect.sqlToQuery(
      invFind.mock.calls[invFind.mock.calls.length - 1][0].where,
    );
    expect(invLookup.sql).toContain('lower("workspace_invitations"."email")');
    expect(values.mock.calls[0][0].email).toBe('sara@x.com');

    await expect(
      service.inviteMember('ws1', { email: 'OWNER@acme.com' } as any, 'owner1'),
    ).rejects.toThrow('already the workspace owner');
  });
});

describe('WorkspaceMembersService.acceptInvitation email (B2)', () => {
  function acceptDb(invitedBy: string) {
    const invitationRow = {
      id: 'inv1',
      workspaceId: 'ws1',
      status: 'PENDING',
      email: 'sana@lumierecafe.pk',
      invitedBy,
      expiresAt: new Date('2099-01-01T00:00:00Z'),
      workspace: { id: 'ws1', name: 'Rehman Workspace', timezone: 'UTC' },
      inviter: { id: invitedBy, name: 'M Rehman' },
    };
    const acceptedRow = {
      ...invitationRow,
      status: 'ACCEPTED',
      role: 'MEMBER',
      acceptedAt: new Date('2026-10-26T10:42:00Z'),
    };
    return withTx({
      query: {
        workspaceInvitation: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce(invitationRow)
            .mockResolvedValueOnce(undefined),
        },
        users: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'user-1',
            name: 'Sana Noor',
            email: 'sana@lumierecafe.pk',
          }),
        },
      },
      update: () => ({
        set: () => ({
          where: () => ({ returning: () => Promise.resolve([acceptedRow]) }),
        }),
      }),
    });
  }

  const usage: any = {
    incrementMemberCount: jest.fn().mockResolvedValue(undefined),
  };
  const users: any = {
    verifyEmail: jest.fn().mockResolvedValue(undefined),
    markOnboardingCompleted: jest.fn().mockResolvedValue(undefined),
  };

  it('tells the inviter with a bell and the B2 email, not the accepter', async () => {
    const mail = makeMail();
    await build(
      acceptDb('owner1'),
      usage,
      users,
      noRole,
      mail,
    ).acceptInvitation('tok', 'user-1');

    expect(mail.notify.notify).toHaveBeenCalledTimes(1);
    const input = mail.notify.notify.mock.calls[0][0];
    expect(input.userId).toBe('owner1');
    expect(input.workspaceId).toBe('ws1');
    expect(input.event).toBe('member_activity');
    expect(input.email?.template.id).toBe('invitation-accepted');
    expect(input.email?.idempotencyKey).toBe('invite-accepted.inv1');
    expect(input.email?.props).toEqual({
      memberName: 'Sana Noor',
      memberEmail: 'sana@lumierecafe.pk',
      workspaceName: 'Rehman Workspace',
      role: 'MEMBER',
      joined: 'Oct 26, 2026',
      membersUrl: 'http://localhost:3001/w/ws1/settings/team',
    });
    await input.bell?.();
    expect(mail.emitter.invitationAccepted).toHaveBeenCalledWith(
      'owner1',
      'Sana Noor',
      'Rehman Workspace',
    );
  });

  it('does not notify when the accepter is the inviter', async () => {
    const mail = makeMail();
    await build(
      acceptDb('user-1'),
      usage,
      users,
      noRole,
      mail,
    ).acceptInvitation('tok', 'user-1');
    expect(mail.notify.notify).not.toHaveBeenCalled();
  });

  it('still accepts when notifying fails', async () => {
    const mail = makeMail();
    mail.notify.notify.mockRejectedValue(new Error('queue down'));
    await expect(
      build(acceptDb('owner1'), usage, users, noRole, mail).acceptInvitation(
        'tok',
        'user-1',
      ),
    ).resolves.toMatchObject({ message: 'Invitation accepted successfully' });
  });
});

describe('WorkspaceMembersService.removeMember email (B3)', () => {
  function removeDb(member: { userId: string | null }) {
    return {
      query: {
        workspace: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'ws1',
            ownerId: 'owner1',
            name: 'Rehman Workspace',
            timezone: 'UTC',
          }),
        },
        workspaceInvitation: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce({ id: 'm1', status: 'ACCEPTED', ...member }) // the member
            .mockResolvedValue(undefined), // isUserAdmin
        },
      },
      // The soft removal: the conditional update finds the ACCEPTED row.
      update: () => ({
        set: () => ({
          where: () => ({ returning: () => Promise.resolve([{ id: 'm1' }]) }),
        }),
      }),
    };
  }

  const usage: any = {
    decrementMemberCount: jest.fn().mockResolvedValue(undefined),
  };

  it('rings the bell now and queues B3 for after the undo window', async () => {
    const mail = makeMail();
    await build(
      removeDb({ userId: 'user-1' }),
      usage,
      {},
      noRole,
      mail,
    ).removeMember('ws1', 'm1', 'owner1');

    expect(mail.notify.notify).toHaveBeenCalledTimes(1);
    const input = mail.notify.notify.mock.calls[0][0];
    expect(input.userId).toBe('user-1');
    expect(input.workspaceId).toBe('ws1');
    expect(input.event).toBeNull();
    expect(input.email?.template.id).toBe('removed-from-workspace');
    const key = input.email?.idempotencyKey ?? '';
    expect(key).toMatch(/^member-removed\.m1\.\d+$/);
    // The undo window plus a 30 s margin, built from the window constant.
    expect(input.email?.delayMs).toBe(MEMBER_RESTORE_WINDOW_MS + 30_000);
    expect(MEMBER_REMOVED_EMAIL_DELAY_MS).toBe(15 * 60 * 1000 + 30_000);
    const { removedOn, ...rest } = input.email?.props as {
      removedOn: string;
    };
    // The send-time guard checks the key's removal: same row, same instant.
    expect(rest).toEqual({
      workspaceName: 'Rehman Workspace',
      removedByName: 'M Rehman',
      openUrl: 'http://localhost:3001/',
      membershipId: 'm1',
      removedAtMs: Number(key.split('.')[2]),
    });
    expect(removedOn).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
    await input.bell?.();
    expect(mail.emitter.memberRemoved).toHaveBeenCalledWith(
      'user-1',
      'Rehman Workspace',
      'M Rehman',
    );
  });

  it('sends nothing when a member leaves on their own', async () => {
    const mail = makeMail();
    await build(
      removeDb({ userId: 'user-1' }),
      usage,
      {},
      noRole,
      mail,
    ).removeMember('ws1', 'm1', 'user-1');
    expect(mail.notify.notify).not.toHaveBeenCalled();
  });

  it('sends nothing for a member row that has no user', async () => {
    const mail = makeMail();
    await build(
      removeDb({ userId: null }),
      usage,
      {},
      noRole,
      mail,
    ).removeMember('ws1', 'm1', 'owner1');
    expect(mail.notify.notify).not.toHaveBeenCalled();
  });

  it('still removes the member when notifying fails', async () => {
    const mail = makeMail();
    mail.notify.notify.mockRejectedValue(new Error('queue down'));
    await expect(
      build(
        removeDb({ userId: 'user-1' }),
        usage,
        {},
        noRole,
        mail,
      ).removeMember('ws1', 'm1', 'owner1'),
    ).resolves.toEqual({ message: 'Member removed successfully' });
  });
});
