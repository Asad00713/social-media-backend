import { NotFoundException } from '@nestjs/common';
import { WorkspaceAccessService } from './workspace-access.service';

function make(role: string | null, isSuper = false) {
  const roles = {
    getRole: jest.fn().mockResolvedValue(role),
    isPlatformSuperAdmin: jest.fn().mockResolvedValue(isSuper),
  };
  return { svc: new WorkspaceAccessService(roles as any), roles };
}

describe('WorkspaceAccessService.assertCan', () => {
  it('returns the role when it satisfies the capability', async () => {
    const { svc, roles } = make('MEMBER');
    await expect(svc.assertCan('w', 'u', 'posts:publish')).resolves.toBe(
      'MEMBER',
    );
    expect(roles.getRole).toHaveBeenCalledWith('w', 'u');
  });

  it('throws NotFound when the role is too low', async () => {
    const { svc } = make('GUEST');
    await expect(
      svc.assertCan('w', 'u', 'posts:publish'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFound for a non-member', async () => {
    const { svc } = make(null);
    await expect(svc.assertCan('w', 'u', 'posts:draft')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('lets a platform super admin through', async () => {
    const { svc } = make(null, true);
    await expect(svc.assertCan('w', 'sa', 'billing:manage')).resolves.toBe(
      'SUPER_ADMIN',
    );
  });

  it('does not look up super admin when the role already passes', async () => {
    const { svc, roles } = make('OWNER');
    await svc.assertCan('w', 'u', 'billing:manage');
    expect(roles.isPlatformSuperAdmin).not.toHaveBeenCalled();
  });
});
