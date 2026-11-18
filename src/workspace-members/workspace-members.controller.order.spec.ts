import 'reflect-metadata';
import {
  ExecutionContext,
  RequestMethod,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import {
  ThrottlerException,
  ThrottlerGuard,
  ThrottlerStorageService,
} from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMembersController } from './workspace-members.controller';
import { REQUIRE_CAPABILITY } from './require-capability.decorator';
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

  it('resendInvitation is POST :workspaceId/invitations/:invitationId/resend, before the invitation catch-all', () => {
    expect(route('resendInvitation')).toEqual({
      path: ':workspaceId/invitations/:invitationId/resend',
      method: RequestMethod.POST,
    });
    const resend = methodsInDeclarationOrder.indexOf('resendInvitation');
    const cancel = methodsInDeclarationOrder.indexOf('cancelInvitation');
    expect(resend).toBeGreaterThanOrEqual(0);
    expect(resend).toBeLessThan(cancel);
  });

  it('resendInvitation answers 200 behind JWT, role and throttle guards, in that order', () => {
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf('resendInvitation')),
    ).toBe(200);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, handlerOf('resendInvitation')),
    ).toEqual([JwtAuthGuard, WorkspaceRoleGuard, ThrottlerGuard]);
    expect(
      Reflect.getMetadata(REQUIRE_CAPABILITY, handlerOf('resendInvitation')),
    ).toBe('team:manage');
  });

  it('hands the caller own id to the service, never an id from the URL', async () => {
    const leaveWorkspace = jest.fn().mockResolvedValue(undefined);
    const controller = new WorkspaceMembersController(
      { leaveWorkspace } as never,
      {} as never,
    );
    await controller.leaveWorkspace('ws-1', {
      userId: 'user-1',
      email: 'a@example.test',
    });
    expect(leaveWorkspace).toHaveBeenCalledWith('ws-1', 'user-1');
  });

  it('hands workspace, invitation and the caller to resendInvitation', async () => {
    const resendInvitation = jest.fn().mockResolvedValue({ id: 'inv-1' });
    const controller = new WorkspaceMembersController(
      { resendInvitation } as never,
      {} as never,
    );
    await controller.resendInvitation('ws-1', 'inv-1', {
      userId: 'user-1',
      email: 'a@example.test',
    });
    expect(resendInvitation).toHaveBeenCalledWith('ws-1', 'inv-1', 'user-1');
  });
});

describe('POST invitations/:invitationId/resend throttle', () => {
  let storage: ThrottlerStorageService;
  let guard: ThrottlerGuard;

  beforeEach(async () => {
    storage = new ThrottlerStorageService();
    // The app-wide default (100 a minute); the route's own limit must win.
    guard = new ThrottlerGuard(
      [{ ttl: 60_000, limit: 100 }],
      storage,
      new Reflector(),
    );
    await guard.onModuleInit();
  });
  afterEach(() => storage.onApplicationShutdown());

  function attempt(
    params: Record<string, string> | undefined,
    userId: string,
  ): Promise<boolean> {
    const req = {
      params,
      user: { userId },
      ip: '1.1.1.1',
      headers: {},
    };
    const context = {
      getHandler: () => WorkspaceMembersController.prototype.resendInvitation,
      getClass: () => WorkspaceMembersController,
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({ header: jest.fn() }),
      }),
    } as unknown as ExecutionContext;
    return guard.canActivate(context);
  }

  it('is 10 an hour per workspace, shared by everyone who manages it', async () => {
    for (let i = 0; i < 10; i++) {
      await expect(
        attempt({ workspaceId: 'ws-1' }, `user-${i % 3}`),
      ).resolves.toBe(true);
    }
    await expect(
      attempt({ workspaceId: 'ws-1' }, 'user-new'),
    ).rejects.toBeInstanceOf(ThrottlerException);
    // Another workspace has its own budget.
    await expect(attempt({ workspaceId: 'ws-2' }, 'user-0')).resolves.toBe(
      true,
    );
  });

  it('without a workspace param it is a 401, not a TypeError', async () => {
    await expect(attempt(undefined, 'user-0')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(attempt({}, 'user-0')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
