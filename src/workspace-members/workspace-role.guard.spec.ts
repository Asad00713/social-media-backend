import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WorkspaceRoleGuard } from './workspace-role.guard';

function ctx(params: any, user: any): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ params, user }) }), getHandler: () => ({}), getClass: () => ({}) } as any;
}
describe('WorkspaceRoleGuard', () => {
  const reflector = { getAllAndOverride: jest.fn() } as unknown as Reflector;
  it('allows when role satisfies the capability', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue('posts:publish');
    const roleSvc = { getRole: jest.fn().mockResolvedValue('MEMBER') } as any;
    const guard = new WorkspaceRoleGuard(reflector, roleSvc);
    await expect(guard.canActivate(ctx({ workspaceId: 'w' }, { userId: 'u' }))).resolves.toBe(true);
  });
  it('denies when role is too low', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue('team:manage');
    const roleSvc = { getRole: jest.fn().mockResolvedValue('MEMBER') } as any;
    const guard = new WorkspaceRoleGuard(reflector, roleSvc);
    await expect(guard.canActivate(ctx({ workspaceId: 'w' }, { userId: 'u' }))).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('passes through when no capability metadata is set', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(undefined);
    const guard = new WorkspaceRoleGuard(reflector, { getRole: jest.fn() } as any);
    await expect(guard.canActivate(ctx({}, { userId: 'u' }))).resolves.toBe(true);
  });
  it('denies a non-member (null role) when a capability is required', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue('analytics:view');
    const guard = new WorkspaceRoleGuard(reflector, { getRole: jest.fn().mockResolvedValue(null) } as any);
    await expect(guard.canActivate(ctx({ workspaceId: 'w' }, { userId: 'u' }))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
