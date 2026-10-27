import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { REQUIRE_CAPABILITY } from '../../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../../workspace-members/workspace-role.guard';
import { WorkspaceRoleService } from '../../workspace-members/workspace-role.service';
import { InboxSettingsController } from './inbox-settings.controller';
import {
  DEFAULT_INBOX_SETTINGS,
  InboxSettingsService,
} from './services/inbox-settings.service';

const WS = '11111111-1111-4111-8111-111111111111';

describe('InboxSettingsController over HTTP', () => {
  let app: INestApplication<App>;
  const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
  const settings = { get: jest.fn(), update: jest.fn() };
  const url = `/inbox/workspaces/${WS}/settings`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InboxSettingsController],
      providers: [
        WorkspaceRoleGuard,
        { provide: WorkspaceRoleService, useValue: roles },
        { provide: InboxSettingsService, useValue: settings },
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
    settings.get.mockResolvedValue(DEFAULT_INBOX_SETTINGS);
    settings.update.mockResolvedValue({
      ...DEFAULT_INBOX_SETTINGS,
      aiQuickReplies: false,
    });
  });

  it('lets a GUEST read their settings', async () => {
    await request(app.getHttpServer())
      .get(url)
      .expect(200, DEFAULT_INBOX_SETTINGS);
    expect(settings.get).toHaveBeenCalledWith('user-1', WS);
  });

  it('lets a GUEST update their settings', async () => {
    await request(app.getHttpServer())
      .put(url)
      .send({ aiQuickReplies: false })
      .expect(200, { ...DEFAULT_INBOX_SETTINGS, aiQuickReplies: false });
    expect(settings.update).toHaveBeenCalledWith('user-1', WS, {
      aiQuickReplies: false,
    });
  });

  it.each([
    [{ notify: 'loud' }, 'bad enum'],
    [{ defaultLater: 'never' }, 'bad enum'],
    [{ markDoneOnReply: 'yes' }, 'not a boolean'],
    [{ extra: 1 }, 'extra key'],
    [{ notify: null }, 'null enum'],
    [{ aiQuickReplies: null }, 'null boolean'],
  ])('answers 400 to %j (%s)', async (body) => {
    await request(app.getHttpServer()).put(url).send(body).expect(400);
    expect(settings.update).not.toHaveBeenCalled();
  });

  it('answers 400 to a non-uuid workspace id', async () => {
    await request(app.getHttpServer())
      .get('/inbox/workspaces/nope/settings')
      .expect(400);
  });

  it('answers 403 to a non-member', async () => {
    roles.getRole.mockResolvedValue(null);
    await request(app.getHttpServer()).get(url).expect(403);
    await request(app.getHttpServer()).put(url).send({}).expect(403);
    expect(settings.get).not.toHaveBeenCalled();
    expect(settings.update).not.toHaveBeenCalled();
  });

  it('both handlers need inbox:view', () => {
    const cap = (n: keyof InboxSettingsController) =>
      Reflect.getMetadata(
        REQUIRE_CAPABILITY,
        InboxSettingsController.prototype[n],
      ) as string | undefined;
    expect(cap('get')).toBe('inbox:view');
    expect(cap('put')).toBe('inbox:view');
  });
});
