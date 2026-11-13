import 'reflect-metadata';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { AppModule } from '../../app.module';
import { REQUIRE_CAPABILITY } from '../../workspace-members/require-capability.decorator';
import type { WorkspaceRole } from '../../workspace-members/role-capabilities';
import { WorkspaceRoleGuard } from '../../workspace-members/workspace-role.guard';
import type { WorkspaceRoleService } from '../../workspace-members/workspace-role.service';
import { collectControllerRoutes } from '../../workspace-members/testing/controller-routes';
import { ChannelPageController } from './channel-page.controller';
import { ChannelPageModule } from './channel-page.module';

const PREFIX = '/channels/workspaces/:workspaceId';

// The channel page's routes, with the request each must answer. Each
// request is matched against EVERY other route in the app: Express takes
// the first registered match, so any other route that matched one of these
// would shadow it, whatever the module order.
const PAGE_ROUTES = [
  {
    key: `GET ${PREFIX}/:channelId/page`,
    url: '/channels/workspaces/11111111-1111-4111-8111-111111111111/42/page',
  },
  {
    key: `GET ${PREFIX}/:channelId/posts`,
    url: '/channels/workspaces/11111111-1111-4111-8111-111111111111/42/posts',
  },
  {
    key: `PATCH ${PREFIX}/:channelId/settings`,
    url: '/channels/workspaces/11111111-1111-4111-8111-111111111111/42/settings',
  },
];

/** An Express-style path as a regex: `:param` is one segment. */
const matcher = (fullPath: string): RegExp =>
  new RegExp(
    '^' +
      fullPath
        .split('/')
        .map((seg) =>
          seg.startsWith(':')
            ? '[^/]+'
            : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        )
        .join('/') +
      '/?$',
  );

describe('channel page routes', () => {
  const { routes } = collectControllerRoutes();

  it.each(PAGE_ROUTES)('$key exists exactly once', ({ key }) => {
    expect(routes.filter((r) => r.key === key)).toHaveLength(1);
  });

  it.each(PAGE_ROUTES)(
    'no other route can answer $url ($key)',
    ({ key, url }) => {
      const method = key.split(' ')[0];
      const rivals = routes
        .filter((r) => r.key !== key && r.key.startsWith(`${method} `))
        .filter((r) => matcher(r.fullPath).test(url))
        .map((r) => `${r.key} (${r.controller}.${r.handler})`);
      expect(rivals).toEqual([]);
    },
  );

  it('the matcher really sees a param route as a rival (self-check)', () => {
    expect(
      matcher(`${PREFIX}/:channelId/:anything`).test(PAGE_ROUTES[0].url),
    ).toBe(true);
    expect(matcher(`${PREFIX}/:channelId`).test(PAGE_ROUTES[0].url)).toBe(
      false,
    );
  });

  it('ChannelPageModule is part of the app', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      AppModule,
    ) as unknown[];
    expect(imports).toContain(ChannelPageModule);
    expect(
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ChannelPageModule),
    ).toEqual([ChannelPageController]);
  });
});

describe('ChannelPageController guards', () => {
  const proto = ChannelPageController.prototype as unknown as Record<
    string,
    object
  >;

  it.each(['getPage', 'listPosts'])(
    '%s needs posts:draft behind both guards',
    (handler) => {
      expect(Reflect.getMetadata(REQUIRE_CAPABILITY, proto[handler])).toBe(
        'posts:draft',
      );
      const guards = Reflect.getMetadata(
        '__guards__',
        ChannelPageController,
      ) as unknown[];
      expect(guards).toEqual([JwtAuthGuard, WorkspaceRoleGuard]);
    },
  );

  const run = (handler: string, role: WorkspaceRole | null) => {
    const roles = {
      getRole: jest.fn(() => Promise.resolve(role)),
      isPlatformSuperAdmin: jest.fn(() => Promise.resolve(false)),
    } as unknown as WorkspaceRoleService;
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          user: { userId: 'u1' },
          params: { workspaceId: 'w1', channelId: '7' },
        }),
      }),
      getHandler: () => proto[handler],
      getClass: () => ChannelPageController,
    } as unknown as ExecutionContext;
    return new WorkspaceRoleGuard(new Reflector(), roles).canActivate(ctx);
  };

  it.each(['getPage', 'listPosts'])('a GUEST can read %s', async (h) => {
    await expect(run(h, 'GUEST')).resolves.toBe(true);
  });

  it.each(['getPage', 'listPosts'])(
    'a non-member cannot read %s',
    async (h) => {
      await expect(run(h, null)).rejects.toBeInstanceOf(ForbiddenException);
    },
  );
});
