import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { REQUIRE_CAPABILITY } from '../../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../../workspace-members/workspace-role.guard';
import { WorkspaceRoleService } from '../../workspace-members/workspace-role.service';
import { ConversationsController } from './conversations.controller';
import { ConversationMutationsService } from './services/conversation-mutations.service';
import { ConversationListService } from './services/conversation-list.service';
import { ConversationPresenter } from './services/conversation-presenter.service';

const WS = '11111111-1111-4111-8111-111111111111';

describe('ConversationsController over HTTP', () => {
  let app: INestApplication<App>;
  const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
  const list = { list: jest.fn() };
  const presenter = { counts: jest.fn() };
  const mutations = {
    patch: jest.fn(),
    bulk: jest.fn(),
    markRead: jest.fn(),
    markUnread: jest.fn(),
    remove: jest.fn(),
    restore: jest.fn(),
  };
  const CONV = '22222222-2222-4222-8222-222222222222';
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
        { provide: ConversationMutationsService, useValue: mutations },
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
    for (const m of Object.values(mutations)) m.mockResolvedValue({ ok: true });
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

  describe('mutations', () => {
    const base = `${url}/${CONV}`;
    const guestCalls: Array<[string, string, object | null]> = [
      ['patch', base, { status: 'done' }],
      ['post', `${url}/bulk`, { ids: [CONV], action: 'done' }],
      ['post', `${base}/unread`, null],
      ['delete', base, null],
      ['post', `${base}/restore`, null],
    ];

    it.each(guestCalls)(
      'answers 403 to a GUEST on %s %s',
      async (m, path, body) => {
        const agent = request(app.getHttpServer()) as unknown as Record<
          string,
          (p: string) => request.Test
        >;
        const req = agent[m](path);
        await (body ? req.send(body) : req).expect(403);
        for (const fn of Object.values(mutations))
          expect(fn).not.toHaveBeenCalled();
      },
    );

    it('lets a GUEST mark a conversation read (shared read state)', async () => {
      await request(app.getHttpServer()).post(`${base}/read`).expect(200);
      expect(mutations.markRead).toHaveBeenCalledWith(WS, CONV);
    });

    it('lets a MEMBER patch, with the user and body forwarded', async () => {
      roles.getRole.mockResolvedValue('MEMBER');
      await request(app.getHttpServer())
        .patch(base)
        .send({ status: 'later', laterPreset: 'tomorrow' })
        .expect(200);
      expect(mutations.patch).toHaveBeenCalledWith(
        WS,
        CONV,
        'user-1',
        expect.objectContaining({ status: 'later', laterPreset: 'tomorrow' }),
      );
    });

    it('answers 200 to remove, unread and restore for a MEMBER', async () => {
      roles.getRole.mockResolvedValue('MEMBER');
      await request(app.getHttpServer()).delete(base).expect(200);
      await request(app.getHttpServer()).post(`${base}/unread`).expect(200);
      await request(app.getHttpServer()).post(`${base}/restore`).expect(200);
      expect(mutations.remove).toHaveBeenCalledWith(WS, CONV);
      expect(mutations.restore).toHaveBeenCalledWith(WS, CONV);
      expect(mutations.markUnread).toHaveBeenCalledWith(WS, CONV, 'user-1');
    });

    it.each([
      ['status snoozed', { status: 'snoozed' }],
      ['bad laterUntil', { status: 'later', laterUntil: 'tomorrow-ish' }],
      ['bad assignee', { assigneeUserId: 'nope' }],
      ['unknown key', { foo: 1 }],
    ])('PATCH answers 400 to %s', async (_n, body) => {
      roles.getRole.mockResolvedValue('MEMBER');
      await request(app.getHttpServer()).patch(base).send(body).expect(400);
      expect(mutations.patch).not.toHaveBeenCalled();
    });

    it('accepts null laterUntil and null assignee', async () => {
      roles.getRole.mockResolvedValue('MEMBER');
      await request(app.getHttpServer())
        .patch(base)
        .send({ laterUntil: null, assigneeUserId: null })
        .expect(200);
    });

    it('bulk answers 400 to 101 ids, none, a bad id or a bad action', async () => {
      roles.getRole.mockResolvedValue('MEMBER');
      const many = Array.from({ length: 101 }, () => CONV);
      for (const body of [
        { ids: many, action: 'done' },
        { ids: [], action: 'done' },
        { ids: ['x'], action: 'done' },
        { ids: [CONV], action: 'archive' },
      ]) {
        await request(app.getHttpServer())
          .post(`${url}/bulk`)
          .send(body)
          .expect(400);
      }
      expect(mutations.bulk).not.toHaveBeenCalled();
      await request(app.getHttpServer())
        .post(`${url}/bulk`)
        .send({ ids: Array.from({ length: 100 }, () => CONV), action: 'done' })
        .expect(201);
    });

    it('routes a non-uuid id to 400, never to the service', async () => {
      roles.getRole.mockResolvedValue('MEMBER');
      await request(app.getHttpServer()).delete(`${url}/nope`).expect(400);
      expect(mutations.remove).not.toHaveBeenCalled();
    });

    it('declares the capability per handler', () => {
      const cap = (n: keyof ConversationsController) =>
        Reflect.getMetadata(
          REQUIRE_CAPABILITY,
          ConversationsController.prototype[n],
        ) as string | undefined;
      for (const n of [
        'patch',
        'bulk',
        'unread',
        'remove',
        'restore',
      ] as const) {
        expect(cap(n)).toBe('inbox:reply');
      }
      expect(cap('read')).toBe('inbox:view');
    });
  });
});
