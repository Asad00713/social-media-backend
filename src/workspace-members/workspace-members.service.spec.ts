import { WorkspaceMembersService } from './workspace-members.service';

describe('WorkspaceMembersService.inviteMember email', () => {
  it('sends an invitation email after creating the invitation', async () => {
    const invitationRow = {
      id: 'inv1',
      email: 'new@acme.com',
      role: 'MEMBER',
      token: 'tok123',
      expiresAt: new Date('2026-08-02T00:00:00Z'),
    };
    const db: any = {
      query: {
        workspace: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 'ws1', ownerId: 'owner1', name: 'Acme' }),
        },
        users: { findFirst: jest.fn().mockResolvedValue(undefined) },
        workspaceInvitation: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      insert: () => ({
        values: () => ({ returning: () => Promise.resolve([invitationRow]) }),
      }),
    };
    const usageService: any = { enforceMemberLimit: jest.fn().mockResolvedValue(undefined) };
    const emailService: any = {
      sendWorkspaceInvitation: jest.fn().mockResolvedValue({ success: true }),
    };

    const service = new WorkspaceMembersService(db, usageService, emailService);
    await service.inviteMember(
      'ws1',
      { email: 'new@acme.com', role: 'MEMBER' } as any,
      'owner1',
    );

    expect(emailService.sendWorkspaceInvitation).toHaveBeenCalledWith(
      'new@acme.com',
      expect.objectContaining({ token: 'tok123', role: 'MEMBER' }),
    );
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
    const service = new WorkspaceMembersService(db, {} as any, {} as any);
    const res = await service.previewInvitation('tok123');
    expect(res).toEqual({
      workspaceName: 'Acme', inviterName: 'Sam', invitedEmail: 'new@acme.com',
      role: 'MEMBER', status: 'PENDING', expired: true,
    });
    expect((res as any).token).toBeUndefined();
  });
});

describe('WorkspaceMembersService.batchInvite seat gate', () => {
  it('rejects the whole batch when it exceeds remaining seats', async () => {
    const db: any = {
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
    };
    const usageService: any = {
      getWorkspaceUsage: jest.fn().mockResolvedValue({ membersLimit: 2, membersCount: 1, membersAvailable: 1 }),
    };
    const emailService: any = { sendWorkspaceInvitation: jest.fn().mockResolvedValue({ success: true }) };
    const svc = new WorkspaceMembersService(db, usageService, emailService);
    // reserved = membersCount(1) + pending(0) = 1; limit 2 → 1 seat left; batch of 2 → exceeds
    await expect(
      svc.batchInvite('w', [{ email: 'a@x.com', role: 'MEMBER' }, { email: 'b@x.com', role: 'MEMBER' }] as any, 'owner'),
    ).rejects.toThrow(/SEAT_LIMIT_EXCEEDED/);
  });
});
