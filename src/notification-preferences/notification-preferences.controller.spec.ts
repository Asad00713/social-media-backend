import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { REQUIRE_CAPABILITY } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { WorkspaceRoleService } from '../workspace-members/workspace-role.service';
import { NotificationPreferencesController } from './notification-preferences.controller';
import { NotificationPreferencesService } from './notification-preferences.service';

const WS = '11111111-1111-4111-8111-111111111111';
const BASE = `/workspaces/${WS}/notification-preferences`;
const GOOD = {
  changes: [{ event: 'member_activity', channel: 'email', enabled: true }],
};

describe('NotificationPreferencesController routes', () => {
  const proto =
    NotificationPreferencesController.prototype as unknown as Record<
      string,
      object
    >;

  it('routes are workspace-guarded with team:view', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      NotificationPreferencesController,
    ) as unknown[];
    expect(guards).toEqual([JwtAuthGuard, WorkspaceRoleGuard]);
    expect(Reflect.getMetadata('path', NotificationPreferencesController)).toBe(
      'workspaces/:workspaceId/notification-preferences',
    );
    for (const handler of ['list', 'update']) {
      expect(Reflect.getMetadata(REQUIRE_CAPABILITY, proto[handler])).toBe(
        'team:view',
      );
    }
  });

  it('exposes exactly GET and PUT', () => {
    const handlers = Object.getOwnPropertyNames(proto).filter(
      (n) =>
        n !== 'constructor' &&
        Reflect.getMetadata('path', proto[n]) !== undefined,
    );
    expect(handlers.sort()).toEqual(['list', 'update']);
  });
});

describe('NotificationPreferencesController over HTTP', () => {
  let app: INestApplication<App>;
  const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
  const prefs = { list: jest.fn(), update: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationPreferencesController],
      providers: [
        WorkspaceRoleGuard,
        { provide: WorkspaceRoleService, useValue: roles },
        { provide: NotificationPreferencesService, useValue: prefs },
      ],
    })
      .overrideGuard(JwtAuthGuard)
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
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });
  afterAll(() => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    roles.getRole.mockResolvedValue('GUEST');
    roles.isPlatformSuperAdmin.mockResolvedValue(false);
    prefs.list.mockResolvedValue({ workspaceId: WS, events: [] });
    prefs.update.mockResolvedValue({ workspaceId: WS, events: [] });
  });

  const http = () => request(app.getHttpServer());

  it('lets every role, a guest included, read its own preferences', async () => {
    await http().get(BASE).expect(200, { workspaceId: WS, events: [] });
    expect(prefs.list).toHaveBeenCalledWith('user-1', WS);
  });

  it('refuses a non-member with 403 and never reaches the service', async () => {
    roles.getRole.mockResolvedValue(null);
    await http().get(BASE).expect(403);
    await http().put(BASE).send(GOOD).expect(403);
    expect(prefs.list).not.toHaveBeenCalled();
    expect(prefs.update).not.toHaveBeenCalled();
  });

  it('rejects a workspace id that is not a UUID', async () => {
    await http().get('/workspaces/nope/notification-preferences').expect(400);
  });

  it('PUT passes the caller and the changes to the service', async () => {
    await http().put(BASE).send(GOOD).expect(200);
    expect(prefs.update).toHaveBeenCalledWith('user-1', WS, GOOD.changes);
  });

  it.each([
    ['an empty changes list', { changes: [] }],
    ['a missing changes list', {}],
    [
      'more than 20 changes',
      { changes: Array.from({ length: 21 }, () => GOOD.changes[0]) },
    ],
    [
      'an unknown event',
      { changes: [{ event: 'nope', channel: 'email', enabled: true }] },
    ],
    [
      'inactivity_reminder (account-level, not in the matrix)',
      {
        changes: [
          { event: 'inactivity_reminder', channel: 'email', enabled: false },
        ],
      },
    ],
    [
      'a bad channel',
      { changes: [{ event: 'post_failed', channel: 'sms', enabled: true }] },
    ],
    [
      'a non-boolean enabled',
      {
        changes: [{ event: 'post_failed', channel: 'email', enabled: 'yes' }],
      },
    ],
  ])('PUT rejects %s with 400', async (_name, body) => {
    await http().put(BASE).send(body).expect(400);
    expect(prefs.update).not.toHaveBeenCalled();
  });
});
