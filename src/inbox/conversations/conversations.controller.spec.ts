import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { REQUIRE_CAPABILITY } from '../../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../../workspace-members/workspace-role.guard';
import { WorkspaceRoleService } from '../../workspace-members/workspace-role.service';
import { ConversationsController } from './conversations.controller';
import { ConversationListService } from './services/conversation-list.service';
import { ConversationPresenter } from './services/conversation-presenter.service';

const WS = '11111111-1111-4111-8111-111111111111';

describe('ConversationsController over HTTP', () => {
  let app: INestApplication<App>;
  const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
  const list = { list: jest.fn() };
  const presenter = { counts: jest.fn() };
  const url = `/inbox/workspaces/${WS}/conversations`;
  const empty = { rows: [], nextCursor: null, total: 0 };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ConversationsController],
      providers: [
        WorkspaceRoleGuard,
        { provide: WorkspaceRoleService, useValue: roles },
        { provide: ConversationListService, useValue: list },
        { provide: ConversationPresenter, useValue: presenter },
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
    list.list.mockResolvedValue(empty);
    presenter.counts.mockResolvedValue({ toReply: 1 });
  });

  it('lets a GUEST list with a parsed query', async () => {
    await request(app.getHttpServer())
      .get(`${url}?channelIds=3&channelIds=5&unread=1&limit=10&q=hi`)
      .expect(200, empty);
    expect(list.list).toHaveBeenCalledTimes(1);
    const [ws, user, query] = list.list.mock.calls[0] as unknown[];
    expect(ws).toBe(WS);
    expect(user).toBe('user-1');
    expect(query).toMatchObject({
      view: 'to_reply',
      type: 'all',
      sort: 'newest',
      channelIds: [3, 5],
      unread: true,
      limit: 10,
      q: 'hi',
    });
  });

  it('accepts one channel id and unread=false', async () => {
    await request(app.getHttpServer())
      .get(`${url}?channelIds=7&unread=false`)
      .expect(200);
    expect((list.list.mock.calls[0] as unknown[])[2]).toMatchObject({
      channelIds: [7],
      unread: false,
    });
  });

  it.each([
    ['limit=51', 'limit too big'],
    ['limit=0', 'limit too small'],
    ['view=all', 'bad view'],
    ['foo=1', 'unknown key'],
    ['unread=maybe', 'bad boolean'],
    ['channelIds=abc', 'bad channel id'],
    ['assigned=you', 'bad assigned'],
    [`q=${'x'.repeat(201)}`, 'q too long'],
  ])('answers 400 to %s (%s)', async (qs) => {
    await request(app.getHttpServer()).get(`${url}?${qs}`).expect(400);
    expect(list.list).not.toHaveBeenCalled();
  });

  it('answers 403 to a non-member', async () => {
    roles.getRole.mockResolvedValue(null);
    await request(app.getHttpServer()).get(url).expect(403);
    await request(app.getHttpServer()).get(`${url}/counts`).expect(403);
    expect(list.list).not.toHaveBeenCalled();
  });

  it('lets a GUEST read counts without touching the list service', async () => {
    await request(app.getHttpServer())
      .get(`${url}/counts`)
      .expect(200, { toReply: 1 });
    expect(presenter.counts).toHaveBeenCalledWith(WS);
    expect(list.list).not.toHaveBeenCalled();
  });

  it('both handlers need inbox:view', () => {
    const cap = (n: keyof ConversationsController) =>
      Reflect.getMetadata(
        REQUIRE_CAPABILITY,
        ConversationsController.prototype[n],
      ) as string | undefined;
    expect(cap('list')).toBe('inbox:view');
    expect(cap('counts')).toBe('inbox:view');
  });
});
