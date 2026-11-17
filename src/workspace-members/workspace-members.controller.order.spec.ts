import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMembersController } from './workspace-members.controller';
import { WorkspaceRoleGuard } from './workspace-role.guard';

const proto = WorkspaceMembersController.prototype;
const handlerOf = (name: string): object => Reflect.get(proto, name) as object;
const methodsInDeclarationOrder = Object.getOwnPropertyNames(proto).filter(
  (name) => name !== 'constructor',
);

const route = (handler: keyof WorkspaceMembersController) => ({
  path: Reflect.getMetadata('path', proto[handler]) as string,
  method: Reflect.getMetadata('method', proto[handler]) as RequestMethod,
});

/**
 * Express matches routes in declaration order. `DELETE :workspaceId/members/me`
 * and `DELETE :workspaceId/members/:memberId` both match `.../members/me`; if
 * the param route comes first it swallows `me` and Leave answers 404 ("Member
 * not found") instead of reaching the leave handler.
 */
describe('WorkspaceMembersController route order', () => {
  it('declares leaveWorkspace (members/me) before removeMember (members/:memberId)', () => {
    const leave = methodsInDeclarationOrder.indexOf('leaveWorkspace');
    const remove = methodsInDeclarationOrder.indexOf('removeMember');
    expect(leave).toBeGreaterThanOrEqual(0);
    expect(remove).toBeGreaterThanOrEqual(0);
    expect(leave).toBeLessThan(remove);
  });

  it('leaveWorkspace is DELETE :workspaceId/members/me', () => {
    expect(route('leaveWorkspace')).toEqual({
      path: ':workspaceId/members/me',
      method: RequestMethod.DELETE,
    });
  });

  it('removeMember is still DELETE :workspaceId/members/:memberId', () => {
    expect(route('removeMember')).toEqual({
      path: ':workspaceId/members/:memberId',
      method: RequestMethod.DELETE,
    });
  });

  it('leaveWorkspace answers 204 behind the JWT and role guards', () => {
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf('leaveWorkspace')),
    ).toBe(204);
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      handlerOf('leaveWorkspace'),
    ) as unknown[];
    expect(guards).toEqual([JwtAuthGuard, WorkspaceRoleGuard]);
  });

  it('hands the caller own id to the service, never an id from the URL', async () => {
    const leaveWorkspace = jest.fn().mockResolvedValue(undefined);
    const controller = new WorkspaceMembersController({
      leaveWorkspace,
    } as never);
    await controller.leaveWorkspace('ws-1', {
      userId: 'user-1',
      email: 'a@example.test',
    });
    expect(leaveWorkspace).toHaveBeenCalledWith('ws-1', 'user-1');
  });
});
