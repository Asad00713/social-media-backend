import { WorkspaceRoleService } from './workspace-role.service';

describe('WorkspaceRoleService.getRole', () => {
  const svc = (db: any) => new WorkspaceRoleService(db);

  it('returns OWNER for the workspace owner', async () => {
    const db: any = {
      query: {
        workspace: {
          findFirst: jest.fn().mockResolvedValue({ id: 'w', ownerId: 'u1' }),
        },
        workspaceInvitation: { findFirst: jest.fn() },
      },
    };
    expect(await svc(db).getRole('w', 'u1')).toBe('OWNER');
  });

  it('returns the accepted invitation role', async () => {
    const db: any = {
      query: {
        workspace: {
          findFirst: jest.fn().mockResolvedValue({ id: 'w', ownerId: 'owner' }),
        },
        workspaceInvitation: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ role: 'ADMIN', status: 'ACCEPTED' }),
        },
      },
    };
    expect(await svc(db).getRole('w', 'u2')).toBe('ADMIN');
  });

  it('returns null for a non-member', async () => {
    const db: any = {
      query: {
        workspace: {
          findFirst: jest.fn().mockResolvedValue({ id: 'w', ownerId: 'owner' }),
        },
        workspaceInvitation: {
          findFirst: jest.fn().mockResolvedValue(undefined),
        },
      },
    };
    expect(await svc(db).getRole('w', 'nobody')).toBeNull();
  });
});
