import 'reflect-metadata';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { REQUIRE_CAPABILITY } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type {
  Capability,
  WorkspaceRole,
} from '../workspace-members/role-capabilities';
import type { WorkspaceRoleService } from '../workspace-members/workspace-role.service';
import { ChannelHubController } from './channel-hub.controller';
import { ChannelsController } from './channels.controller';
import { ChannelsModule } from './channels.module';

// Every route and the capability it must demand. A route missing from the
// table, or carrying another capability, fails the spec.
const EXPECTED: Record<
  string,
  { cap: Capability; method: string; path: string }
> = {
  summary: { cap: 'posts:draft', method: 'GET', path: 'summary' },
  pause: { cap: 'channels:manage', method: 'POST', path: ':channelId/pause' },
  resume: {
    cap: 'channels:manage',
    method: 'POST',
    path: ':channelId/resume',
  },
  requestNetwork: {
    cap: 'channels:manage',
    method: 'POST',
    path: 'network-requests',
  },
  updateSettings: {
    cap: 'channels:manage',
    method: 'PATCH',
    path: ':channelId/settings',
  },
};

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

describe('ChannelHubController', () => {
  const proto = ChannelHubController.prototype as unknown as Record<
    string,
    object
  >;
  const handlers = Object.getOwnPropertyNames(proto).filter(
    (n) =>
      n !== 'constructor' &&
      Reflect.getMetadata('path', proto[n]) !== undefined,
  );
  const guards = (handler: object): unknown[] => [
    ...((Reflect.getMetadata(
      '__guards__',
      ChannelHubController,
    ) as unknown[]) ?? []),
    ...((Reflect.getMetadata('__guards__', handler) as unknown[]) ?? []),
  ];

  it('lives under channels/workspaces/:workspaceId', () => {
    expect(Reflect.getMetadata('path', ChannelHubController)).toBe(
      'channels/workspaces/:workspaceId',
    );
  });

  it('covers every route handler, none missing from the table', () => {
    expect(handlers.sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))(
    '%s requires its capability behind both guards',
    (handler, want) => {
      expect(Reflect.getMetadata(REQUIRE_CAPABILITY, proto[handler])).toBe(
        want.cap,
      );
      expect(Reflect.getMetadata('path', proto[handler])).toBe(want.path);
      const method = Reflect.getMetadata('method', proto[handler]) as number;
      expect(METHODS[method]).toBe(want.method);
      expect(guards(proto[handler])).toContain(JwtAuthGuard);
      expect(guards(proto[handler])).toContain(WorkspaceRoleGuard);
    },
  );

  it('the pause routes need the same capability as editing a channel', () => {
    const channels = ChannelsController.prototype as unknown as Record<
      string,
      object
    >;
    const editCap: unknown = Reflect.getMetadata(
      REQUIRE_CAPABILITY,
      channels.updateChannel,
    );
    expect(EXPECTED.pause.cap).toBe(editCap);
    expect(EXPECTED.resume.cap).toBe(editCap);
    expect(EXPECTED.updateSettings.cap).toBe(editCap);
  });

  describe('PATCH :channelId/settings through the real role guard', () => {
    const run = (role: WorkspaceRole) => {
      const roles = {
        getRole: jest.fn(() => Promise.resolve(role)),
        isPlatformSuperAdmin: jest.fn(() => Promise.resolve(false)),
      } as unknown as WorkspaceRoleService;
      const guard = new WorkspaceRoleGuard(new Reflector(), roles);
      const ctx = {
        switchToHttp: () => ({
          getRequest: () => ({
            user: { userId: 'u1' },
            params: { workspaceId: 'w1', channelId: '7' },
          }),
        }),
        getHandler: () => proto.updateSettings,
        getClass: () => ChannelHubController,
      } as unknown as ExecutionContext;
      return guard.canActivate(ctx);
    };

    it('refuses a GUEST', async () => {
      await expect(run('GUEST')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it.each<WorkspaceRole>(['MEMBER', 'ADMIN', 'OWNER'])(
      'lets a %s through',
      async (role) => {
        await expect(run(role)).resolves.toBe(true);
      },
    );
  });

  it('is registered before ChannelsController, so `summary` is not read as a channel id', () => {
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      ChannelsModule,
    ) as unknown[];
    expect(controllers.indexOf(ChannelHubController)).toBeGreaterThanOrEqual(0);
    expect(controllers.indexOf(ChannelHubController)).toBeLessThan(
      controllers.indexOf(ChannelsController),
    );
  });
});

describe('ChannelsController literal routes come before /:channelId', () => {
  // Nest registers a controller's routes in declaration order and Express
  // matches the first, so a literal segment declared after the param route
  // is unreachable.
  const proto = ChannelsController.prototype as unknown as Record<
    string,
    object
  >;
  const order = Object.getOwnPropertyNames(proto);
  const before = (a: string, b: string) =>
    expect(order.indexOf(a)).toBeLessThan(order.indexOf(b));

  it('stats and expiring before getChannel; reorder before updateChannel', () => {
    before('getChannelStats', 'getChannel');
    before('getExpiringChannels', 'getChannel');
    before('reorderChannels', 'updateChannel');
  });
});
