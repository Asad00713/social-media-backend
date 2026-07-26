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
