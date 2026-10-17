import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { WorkspaceRoleService } from '../workspace-members/workspace-role.service';
import { PostsController } from './posts.controller';
import { PostService } from './services/post.service';
import { PlannerPostsService } from './services/planner-posts.service';
import { PostDraftsService } from './services/post-drafts.service';

const WS = '11111111-1111-4111-8111-111111111111';
const POST = '22222222-2222-4222-8222-222222222222';
const DAY = 24 * 3600 * 1000;

describe('PostsController planner reads over HTTP', () => {
  let app: INestApplication<App>;
  const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
  const planner = { getCalendar: jest.fn(), getOne: jest.fn() };
  const drafts = { list: jest.fn(), setReady: jest.fn(), duplicate: jest.fn() };
  const postService = {
    updatePost: jest.fn(),
    deletePost: jest.fn(),
    publishPost: jest.fn(),
    getPostHistory: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PostsController],
      providers: [
        WorkspaceRoleGuard,
        { provide: WorkspaceRoleService, useValue: roles },
        { provide: PostService, useValue: postService },
        { provide: PlannerPostsService, useValue: planner },
        { provide: PostDraftsService, useValue: drafts },
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
    planner.getCalendar.mockResolvedValue({
      posts: [],
      byDate: {},
      total: 0,
      timezone: 'UTC',
    });
    planner.getOne.mockResolvedValue({ id: POST });
    drafts.list.mockResolvedValue({ drafts: [], total: 0, nextCursor: null });
    drafts.setReady.mockResolvedValue({ id: POST });
    drafts.duplicate.mockResolvedValue({ id: 'new-1' });
  });

  const cal = (qs: string) =>
    request(app.getHttpServer()).get(`/posts/workspaces/${WS}/calendar${qs}`);

  it.each([
    ['', 'no from or to'],
    ['?to=2026-06-30T00:00:00Z', 'no from'],
    ['?from=banana&to=2026-06-30T00:00:00Z', 'from is not a date'],
    ['?from=2026-07-01T00:00:00Z&to=2026-06-01T00:00:00Z', 'from after to'],
  ])('answers 400 to %s (%s)', async (qs) => {
    await cal(qs).expect(400);
    expect(planner.getCalendar).not.toHaveBeenCalled();
  });

  it('answers 400 to a 120-day span', async () => {
    const from = new Date(Date.UTC(2026, 0, 1));
    const to = new Date(from.getTime() + 120 * DAY);
    await cal(`?from=${from.toISOString()}&to=${to.toISOString()}`).expect(400);
    expect(planner.getCalendar).not.toHaveBeenCalled();
  });

  it('lets a guest read a valid range', async () => {
    await cal('?from=2026-06-01T00:00:00Z&to=2026-06-30T00:00:00Z').expect(200);
    expect(planner.getCalendar).toHaveBeenCalledWith(
      WS,
      new Date('2026-06-01T00:00:00Z'),
      new Date('2026-06-30T00:00:00Z'),
    );
  });

  it('returns the enriched post from getPost', async () => {
    await request(app.getHttpServer())
      .get(`/posts/workspaces/${WS}/${POST}`)
      .expect(200, { post: { id: POST } });
    expect(planner.getOne).toHaveBeenCalledWith(WS, POST);
  });

  it('answers 400 to a non-UUID post id without calling the service', async () => {
    await request(app.getHttpServer())
      .get(`/posts/workspaces/${WS}/abc`)
      .expect(400);
    expect(planner.getOne).not.toHaveBeenCalled();
  });

  describe('drafts', () => {
    const get = (qs = '') =>
      request(app.getHttpServer()).get(`/posts/workspaces/${WS}/drafts${qs}`);

    it.each(['?limit=0', '?limit=101', '?limit=abc', '?cursor=%%%'])(
      'answers 400 to %s',
      async (qs) => {
        await get(qs).expect(400);
        expect(drafts.list).not.toHaveBeenCalled();
      },
    );

    it('lets a guest list drafts and reaches listDrafts, not getPost', async () => {
      await get().expect(200, { drafts: [], total: 0, nextCursor: null });
      expect(drafts.list).toHaveBeenCalledWith(WS, {
        limit: 30,
        cursor: undefined,
      });
      expect(planner.getOne).not.toHaveBeenCalled();
    });

    it('passes limit and cursor through', async () => {
      await get('?limit=5&cursor=abc').expect(200);
      expect(drafts.list).toHaveBeenCalledWith(WS, { limit: 5, cursor: 'abc' });
    });
  });

  describe('ready', () => {
    const ready = (body: unknown, ws = WS, id = POST) =>
      request(app.getHttpServer())
        .post(`/posts/workspaces/${ws}/${id}/ready`)
        .send(body as object);

    it.each([
      [{ ready: 'yes' }, 'a string'],
      [{}, 'no ready key'],
      [{ ready: true, extra: 1 }, 'an extra key'],
    ])('answers 400 to %j (%s)', async (body) => {
      await ready(body).expect(400);
      expect(drafts.setReady).not.toHaveBeenCalled();
    });

    it('answers 400 to a non-UUID post id or workspace id', async () => {
      await ready({ ready: true }, WS, 'abc').expect(400);
      await ready({ ready: true }, 'abc', POST).expect(400);
      expect(drafts.setReady).not.toHaveBeenCalled();
    });

    it('lets a guest flag a draft, passing caller and role', async () => {
      await ready({ ready: true }).expect(200, { post: { id: POST } });
      expect(drafts.setReady).toHaveBeenCalledWith(
        WS,
        POST,
        'user-1',
        'GUEST',
        true,
      );
    });
  });

  describe('duplicate', () => {
    const dup = (ws = WS, id = POST) =>
      request(app.getHttpServer()).post(
        `/posts/workspaces/${ws}/${id}/duplicate`,
      );

    it('lets a guest copy a post: 201 with the new post', async () => {
      await dup().expect(201, { post: { id: 'new-1' } });
      expect(drafts.duplicate).toHaveBeenCalledWith(WS, POST, 'user-1');
    });

    it('refuses a non-member', async () => {
      roles.getRole.mockResolvedValue(null);
      await dup().expect(403);
      expect(drafts.duplicate).not.toHaveBeenCalled();
    });

    it('answers 400 to a non-UUID post id', async () => {
      await dup(WS, 'abc').expect(400);
      expect(drafts.duplicate).not.toHaveBeenCalled();
    });
  });

  describe('a non-UUID post id is a 400, never a 500', () => {
    const base = `/posts/workspaces/${WS}/abc`;
    const http = () => request(app.getHttpServer());
    it.each([
      ['update', () => http().put(base).send({})],
      ['delete', () => http().delete(base)],
      ['publish', () => http().post(`${base}/publish`)],
      ['history', () => http().get(`${base}/history`)],
    ])('%s', async (_kind, call) => {
      roles.getRole.mockResolvedValue('OWNER');
      await call().expect(400);
      expect(postService.updatePost).not.toHaveBeenCalled();
      expect(postService.deletePost).not.toHaveBeenCalled();
      expect(postService.publishPost).not.toHaveBeenCalled();
      expect(postService.getPostHistory).not.toHaveBeenCalled();
    });
  });

  it('refuses a non-member without calling the service', async () => {
    roles.getRole.mockResolvedValue(null);
    await cal('?from=2026-06-01T00:00:00Z&to=2026-06-30T00:00:00Z').expect(403);
    expect(planner.getCalendar).not.toHaveBeenCalled();
  });
});
