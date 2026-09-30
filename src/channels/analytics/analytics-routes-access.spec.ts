import { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthGuard } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { REQUIRE_CAPABILITY } from '../../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../../workspace-members/workspace-role.guard';
import { WorkspaceRoleService } from '../../workspace-members/workspace-role.service';
import { AnalyticsController } from './analytics.controller';
import { ChannelRefreshController } from './channel-refresh.controller';
import { CHANNEL_LOOKUP_REPO } from './guards/channel-ownership.guard';
import { AnalyticsService } from './services/analytics.service';

const WS = '11111111-1111-4111-8111-111111111111';
const CHANNEL = 42;

/**
 * Every channel-analytics route is workspace data, so the caller must be a
 * member of that workspace. `ChannelOwnershipGuard` only proves the channel
 * belongs to `:wsId`; on its own it let any signed-in user who knew a
 * workspace id read that workspace's analytics (top posts included), fire a
 * live YouTube demographics call on its token, and spend its refresh quota.
 *
 * Asserted on the controllers' real decorator metadata, like the launch-gate
 * exemptions: `WorkspaceRoleGuard` has its own spec for refusing non-members,
 * and the bug this catches is a route that never asks it.
 */
describe('channel analytics routes require workspace membership', () => {
  const reflector = new Reflector();

  const guardsOf = (controller: object): unknown[] =>
    (Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[]) ?? [];

  const capabilityOf = (controller: { prototype: object }, method: string) =>
    reflector.getAllAndOverride<string | undefined>(REQUIRE_CAPABILITY, [
      (controller.prototype as Record<string, () => unknown>)[method],
      controller as unknown as () => unknown,
    ]);

  describe.each([
    ['AnalyticsController', AnalyticsController],
    ['ChannelRefreshController', ChannelRefreshController],
  ] as const)('%s', (_name, controller) => {
    it('runs WorkspaceRoleGuard after the JWT guard has set req.user', () => {
      const guards = guardsOf(controller);
      const jwt = guards.indexOf(AuthGuard('jwt'));
      const role = guards.indexOf(WorkspaceRoleGuard);
      expect(jwt).toBeGreaterThanOrEqual(0);
      expect(role).toBeGreaterThan(jwt);
    });
  });

  it.each([
    [AnalyticsController, 'getOverview'],
    [AnalyticsController, 'getSyncState'],
    [AnalyticsController, 'getDemographics'],
    [AnalyticsController, 'getTrafficSources'],
    [ChannelRefreshController, 'refresh'],
  ] as const)('%p.%s requires analytics:view', (controller, method) => {
    expect(capabilityOf(controller, method)).toBe('analytics:view');
  });
});

describe('channel analytics over HTTP', () => {
  let app: INestApplication<App>;
  const roles = {
    getRole: jest.fn(),
    isPlatformSuperAdmin: jest.fn(),
  };
  const channels = { findChannel: jest.fn() };
  const analytics = {
    getOverview: jest.fn(),
    requestManualRefresh: jest.fn(),
  };
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ platform: 'youtube' }]),
        }),
      }),
    }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AnalyticsController, ChannelRefreshController],
      providers: [
        WorkspaceRoleGuard,
        { provide: WorkspaceRoleService, useValue: roles },
        { provide: CHANNEL_LOOKUP_REPO, useValue: channels },
        { provide: AnalyticsService, useValue: analytics },
        { provide: DRIZZLE, useValue: db },
      ],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useValue({
        canActivate: (ctx: {
          switchToHttp: () => { getRequest: () => { user?: unknown } };
        }) => {
          ctx.switchToHttp().getRequest().user = { userId: 'user-1' };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    roles.isPlatformSuperAdmin.mockResolvedValue(false);
    channels.findChannel.mockResolvedValue({ id: CHANNEL, workspaceId: WS });
    analytics.getOverview.mockResolvedValue({ ok: true });
    analytics.requestManualRefresh.mockResolvedValue({ queued: true });
  });

  describe('a signed-in user who is not in the workspace', () => {
    beforeEach(() => roles.getRole.mockResolvedValue(null));

    it('is refused the overview, before the channel is even looked up', async () => {
      await request(app.getHttpServer())
        .get(`/analytics/workspaces/${WS}/channels/${CHANNEL}/overview`)
        .expect(403);
      expect(channels.findChannel).not.toHaveBeenCalled();
      expect(analytics.getOverview).not.toHaveBeenCalled();
    });

    it('cannot spend the workspace refresh quota', async () => {
      await request(app.getHttpServer())
        .post(`/channels/workspaces/${WS}/${CHANNEL}/refresh`)
        .expect(403);
      expect(analytics.requestManualRefresh).not.toHaveBeenCalled();
    });
  });

  it('lets a guest, the lowest role, read the overview', async () => {
    roles.getRole.mockResolvedValue('GUEST');
    await request(app.getHttpServer())
      .get(`/analytics/workspaces/${WS}/channels/${CHANNEL}/overview`)
      .expect(200, { ok: true });
    expect(roles.getRole).toHaveBeenCalledWith(WS, 'user-1');
  });
});
