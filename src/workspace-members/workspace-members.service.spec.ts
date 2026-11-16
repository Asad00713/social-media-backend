import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { PgDialect } from 'drizzle-orm/pg-core';
import { socialMediaChannels } from 'src/drizzle/schema';
import { AppLinks } from 'src/email/links/app-links';
import type { EmailResult } from 'src/email/email.service';
import type { EnqueueEmail } from 'src/email/queue/email-job';
import type { EmailOutboxService } from 'src/email/queue/email-outbox.service';
import type { NotificationEmitterService } from 'src/notifications/notification-emitter.service';
import type {
  NotifyInput,
  NotifyService,
} from 'src/notifications/notify.service';
import { RecipientsService } from 'src/notifications/recipients.service';
import { WorkspaceMembersService } from './workspace-members.service';

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
            email: 'new@acme.com', role: 'MEMBER', status: 'PENDING', expiresAt: past,
            workspace: { name: 'Acme' }, inviter: { name: 'Sam' },
          }),
        },
      },
    };
    const service = build(db, {} as any, {} as any, noRole);
    const res = await service.previewInvitation('tok123');
    expect(res).toEqual({
      workspaceName: 'Acme', inviterName: 'Sam', invitedEmail: 'new@acme.com',
      role: 'MEMBER', status: 'PENDING', expired: true,
    });
    expect((res as any).token).toBeUndefined();
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
    expect(usersService.markOnboardingCompleted).toHaveBeenCalledWith(
      'user-1',
    );
  });
});

describe('WorkspaceMembersService.batchInvite seat gate', () => {
  it('rejects the whole batch when it exceeds remaining seats', async () => {
    const db: any = withTx({
      query: {
        workspace: { findFirst: jest.fn().mockResolvedValue({ id: 'w', ownerId: 'owner', name: 'Acme' }) },
        users: { findFirst: jest.fn().mockResolvedValue(undefined) },
        workspaceInvitation: {
          findFirst: jest.fn().mockResolvedValue(undefined),
          findMany: jest.fn().mockResolvedValue([]), // no pending
        },
      },
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: 'i', email: 'x', role: 'MEMBER', token: 't', expiresAt: new Date() }]) }) }),
      // count of accepted members:
      select: () => ({ from: () => ({ where: () => Promise.resolve([{ count: 1 }]) }) }),
    });
    const usageService: any = {
      getWorkspaceUsage: jest.fn().mockResolvedValue({ membersLimit: 2, membersCount: 1, membersAvailable: 1 }),
    };
    const usersService: any = {};
    const svc = build(db, usageService, usersService, noRole);
    // reserved = membersCount(1) + pending(0) = 1; limit 2 → 1 seat left; batch of 2 → exceeds
    await expect(
      svc.batchInvite('w', [{ email: 'a@x.com', role: 'MEMBER' }, { email: 'b@x.com', role: 'MEMBER' }] as any, 'owner'),
    ).rejects.toThrow(/SEAT_LIMIT_EXCEEDED/);
  });
});

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
      query: {
        workspace: { findFirst: jest.fn().mockResolvedValue({ id: 'ws1', ownerId: 'owner1' }) },
        users: { findFirst: findFirstUsers },
        workspaceInvitation: { findFirst: jest.fn().mockResolvedValue(undefined), findMany },
      },
    };
    const service = build(db, {} as any, {} as any, {} as any);

    const result = await service.getMembers('ws1', 'owner1');

    expect(findFirstUsers.mock.calls[0][0].columns).toMatchObject({ lastLoginAt: true });
    expect(findMany.mock.calls[0][0].with.user.columns).toMatchObject({ lastLoginAt: true });
    expect(result.owner?.lastLoginAt).toEqual(lastLogin);
    expect(result.members[0].user?.lastLoginAt).toBeNull();
  });
});

describe('WorkspaceMembersService.inviteMember email case', () => {
  it('matches users and invitations case-insensitively and stores lowercase', async () => {
    const dialect = new PgDialect();
    const userFind = jest.fn().mockImplementation(async (arg: any) =>
      dialect.sqlToQuery(arg.where).sql.includes('"users"."id" =')
        ? { id: 'owner1', email: 'Owner@Acme.com' }
        : undefined,
    );
    const invFind = jest.fn().mockResolvedValue(undefined);
    const values = jest.fn().mockReturnValue({
      returning: () =>
        Promise.resolve([
          { id: 'i', email: 'sara@x.com', role: 'MEMBER', token: 't', expiresAt: new Date() },
        ]),
    });
    const db: any = withTx({
      query: {
        workspace: { findFirst: jest.fn().mockResolvedValue({ id: 'ws1', ownerId: 'owner1', name: 'A' }) },
        users: { findFirst: userFind },
        workspaceInvitation: { findFirst: invFind, findMany: jest.fn().mockResolvedValue([]) },
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

    await service.inviteMember('ws1', { email: ' Sara@X.com ', role: 'MEMBER' } as any, 'owner1');

    const emailLookup = dialect.sqlToQuery(userFind.mock.calls[1][0].where);
    expect(emailLookup.sql).toContain('lower("users"."email")');
    expect(emailLookup.params).toEqual(['sara@x.com']);
    const invLookup = dialect.sqlToQuery(invFind.mock.calls[invFind.mock.calls.length - 1][0].where);
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

  it('tells a removed member with a bell and the B3 email', async () => {
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
    expect(input.email?.idempotencyKey).toMatch(
      /^member-removed\.m1\.\d+$/,
    );
    const { removedOn, ...rest } = input.email?.props as {
      removedOn: string;
    };
    expect(rest).toEqual({
      workspaceName: 'Rehman Workspace',
      removedByName: 'M Rehman',
      openUrl: 'http://localhost:3001/',
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
