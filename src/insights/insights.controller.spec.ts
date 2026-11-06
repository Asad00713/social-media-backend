import { NotFoundException } from '@nestjs/common';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { customWindow, utcToday, windowOf } from '../post-performance/period';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { WorkspaceRoleService } from '../workspace-members/workspace-role.service';
import { InsightsController } from './insights.controller';
import { InsightsService } from './insights.service';

const WS = '11111111-1111-4111-8111-111111111111';

describe('InsightsController over HTTP', () => {
  let app: INestApplication<App>;
  const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
  const insights = {
    overview: jest.fn(),
    posts: jest.fn(),
    csv: jest.fn(),
    postMetrics: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InsightsController],
      providers: [
        WorkspaceRoleGuard,
        { provide: WorkspaceRoleService, useValue: roles },
        { provide: InsightsService, useValue: insights },
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
    await app.init();
  });
  afterAll(() => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    roles.getRole.mockResolvedValue('GUEST');
    roles.isPlatformSuperAdmin.mockResolvedValue(false);
    insights.overview.mockResolvedValue({ ok: true });
    insights.posts.mockResolvedValue({ rows: [] });
    insights.postMetrics.mockResolvedValue([{ postId: 'a' }]);
    insights.csv.mockResolvedValue({
      filename: 'schedura-posts-a-b.csv',
      body: '\uFEFFx\r\n',
    });
  });

  it('refuses a signed-in user who is not in the workspace', async () => {
    roles.getRole.mockResolvedValue(null);
    await request(app.getHttpServer())
      .get(`/insights/workspaces/${WS}/overview`)
      .expect(403);
    expect(insights.overview).not.toHaveBeenCalled();
  });

  it('lets a guest read the overview, passing parsed input through', async () => {
    await request(app.getHttpServer())
      .get(
        `/insights/workspaces/${WS}/overview?days=7&channels=16,15&tz=Asia/Karachi`,
      )
      .expect(200, { ok: true });
    expect(insights.overview).toHaveBeenCalledWith(
      WS,
      { days: 7, window: windowOf(utcToday(new Date()), 7) },
      '16,15',
      'Asia/Karachi',
      'usual',
    );
  });

  it('passes a custom range and a compare mode to the overview', async () => {
    await request(app.getHttpServer())
      .get(
        `/insights/workspaces/${WS}/overview?from=2026-10-01&to=2026-10-14&compare=year`,
      )
      .expect(200);
    expect(insights.overview).toHaveBeenCalledWith(
      WS,
      { days: 14, window: customWindow('2026-10-01', '2026-10-14') },
      undefined,
      'UTC',
      'year',
    );
  });

  it.each([
    ['overview?days=14'],
    ['overview?tz=Mars/Olympus'],
    ['overview?compare=lastyear'],
    ['overview?days=7&from=2026-10-01&to=2026-10-02'],
    ['overview?from=2026-02-30&to=2026-03-02'],
    ['posts?from=2026-10-02&to=2026-10-01'],
    ['posts?from=2026-01-01&to=2026-06-30'],
    ['posts/export?from=2026-10-01'],
    ['posts?limit=500'],
    ['posts?sort=saves'],
    ['posts?format=unknown'],
    // A repeated param arrives as an array: a bad request, not a 500.
    ['overview?channels=1&channels=2'],
    ['posts?channels=1&channels=2'],
    ['posts/export?channels=1&channels=2'],
    // Every scalar param repeated too.
    ['overview?days=7&days=7'],
    ['overview?from=2026-10-01&from=2026-10-01&to=2026-10-02'],
    ['overview?from=2026-10-01&to=2026-10-02&to=2026-10-02'],
    ['overview?compare=year&compare=year'],
    ['overview?tz=UTC&tz=UTC'],
    ['posts?days=7&days=7'],
    ['posts?format=video&format=video'],
    ['posts?sort=likes&sort=likes'],
    ['posts?order=asc&order=asc'],
    ['posts?limit=5&limit=5'],
    ['posts?offset=0&offset=0'],
    ['posts/export?days=7&days=7'],
    ['posts/export?format=video&format=video'],
    ['posts/export?sort=likes&sort=likes'],
    ['posts/export?order=asc&order=asc'],
    [
      'posts/metrics?postIds=22222222-2222-4222-8222-222222222222&postIds=33333333-3333-4333-8333-333333333333',
    ],
  ])('answers 400 to %s', async (path) => {
    await request(app.getHttpServer())
      .get(`/insights/workspaces/${WS}/${path}`)
      .expect(400);
  });

  it('rejects a workspace id that is not a uuid', async () => {
    await request(app.getHttpServer())
      .get('/insights/workspaces/probe/overview')
      .expect(400);
  });

  it('passes the table query to posts', async () => {
    await request(app.getHttpServer())
      .get(
        `/insights/workspaces/${WS}/posts?format=video&sort=likes&order=asc&limit=20&offset=40`,
      )
      .expect(200);
    expect(insights.posts).toHaveBeenCalledWith(
      WS,
      { days: 30, window: windowOf(utcToday(new Date()), 30) },
      undefined,
      {
        format: 'video',
        sort: 'likes',
        order: 'asc',
        limit: 20,
        offset: 40,
      },
    );
  });

  it('posts endpoint passes custom range; export uses it too', async () => {
    const period = {
      days: 14,
      window: customWindow('2026-10-01', '2026-10-14'),
    };
    await request(app.getHttpServer())
      .get(
        `/insights/workspaces/${WS}/posts?from=2026-10-01&to=2026-10-14&sort=usual&format=link&channels=4`,
      )
      .expect(200);
    expect(insights.posts).toHaveBeenCalledWith(WS, period, '4', {
      format: 'link',
      sort: 'usual',
      order: 'desc',
      limit: 10,
      offset: 0,
    });

    await request(app.getHttpServer())
      .get(
        `/insights/workspaces/${WS}/posts/export?from=2026-10-01&to=2026-10-14&sort=reach&order=asc`,
      )
      .expect(200);
    expect(insights.csv).toHaveBeenCalledWith(WS, period, undefined, {
      format: 'all',
      sort: 'reach',
      order: 'asc',
    });
  });

  it.each([
    ['posts'],
    ['posts?from=2026-10-01&to=2026-10-14'],
    ['posts/export'],
    ['posts/export?days=7'],
  ])('403 applies to %s, not only overview', async (path) => {
    roles.getRole.mockResolvedValue(null);
    await request(app.getHttpServer())
      .get(`/insights/workspaces/${WS}/${path}`)
      .expect(403);
    expect(insights.posts).not.toHaveBeenCalled();
    expect(insights.csv).not.toHaveBeenCalled();
  });

  it('downloads the CSV as an attachment', async () => {
    const res = await request(app.getHttpServer())
      .get(`/insights/workspaces/${WS}/posts/export?days=7`)
      .expect(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="schedura-posts-a-b.csv"',
    );
    // The body arrives as sent; supertest may or may not keep the BOM when
    // decoding, so assert on what follows it.
    expect(res.text.replace(/^\uFEFF/, '')).toBe('x\r\n');
  });

  describe('posts/metrics', () => {
    const A = '22222222-2222-4222-8222-222222222222';
    const B = '33333333-3333-4333-8333-333333333333';
    const uuids = (n: number) =>
      Array.from(
        { length: n },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      );
    const get = (q: string) =>
      request(app.getHttpServer()).get(
        `/insights/workspaces/${WS}/posts/metrics${q}`,
      );

    it('lets a guest read metrics for 1..50 post ids', async () => {
      await get(`?postIds=${A},${B}`).expect(200, {
        metrics: [{ postId: 'a' }],
      });
      expect(insights.postMetrics).toHaveBeenCalledWith(WS, [A, B]);
      await get(`?postIds=${uuids(50).join(',')}`).expect(200);
    });

    it('answers 400 to 51 ids, a non-uuid, an empty entry or a missing list', async () => {
      await get(`?postIds=${uuids(51).join(',')}`).expect(400);
      await get('?postIds=notauuid').expect(400);
      await get(`?postIds=${A},`).expect(400);
      await get('?postIds=').expect(400);
      await get('').expect(400);
      expect(insights.postMetrics).not.toHaveBeenCalled();
    });

    it('refuses a signed-in user who is not in the workspace', async () => {
      roles.getRole.mockResolvedValue(null);
      await get(`?postIds=${A}`).expect(403);
      expect(insights.postMetrics).not.toHaveBeenCalled();
    });
  });
});

describe('InsightsController signals over HTTP', () => {
  let app: INestApplication<App>;
  const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
  const insights = { signals: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InsightsController],
      providers: [
        WorkspaceRoleGuard,
        { provide: WorkspaceRoleService, useValue: roles },
        { provide: InsightsService, useValue: insights },
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
    await app.init();
  });
  afterAll(() => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    roles.getRole.mockResolvedValue('GUEST');
    roles.isPlatformSuperAdmin.mockResolvedValue(false);
    insights.signals.mockResolvedValue({ ok: true });
  });

  it('signals answers 403 to a non-member', async () => {
    roles.getRole.mockResolvedValue(null);
    await request(app.getHttpServer())
      .get(`/insights/workspaces/${WS}/signals?channels=4`)
      .expect(403);
    expect(insights.signals).not.toHaveBeenCalled();
  });

  it('lets a guest read signals, passing the channels through', async () => {
    await request(app.getHttpServer())
      .get(`/insights/workspaces/${WS}/signals?channels=4,7`)
      .expect(200, { ok: true });
    expect(insights.signals).toHaveBeenCalledWith(WS, 'user-1', '4,7');
    await request(app.getHttpServer())
      .get(`/insights/workspaces/${WS}/signals`)
      .expect(200);
    expect(insights.signals).toHaveBeenLastCalledWith(WS, 'user-1', undefined);
  });

  it.each([['signals?channels=1&channels=2']])(
    'answers 400 to %s, not a 500',
    async (path) => {
      await request(app.getHttpServer())
        .get(`/insights/workspaces/${WS}/${path}`)
        .expect(400);
      expect(insights.signals).not.toHaveBeenCalled();
    },
  );

  it('rejects a workspace id that is not a uuid', async () => {
    await request(app.getHttpServer())
      .get('/insights/workspaces/probe/signals')
      .expect(400);
    expect(insights.signals).not.toHaveBeenCalled();
  });
});

describe('InsightsController post detail over HTTP', () => {
  let app: INestApplication<App>;
  const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
  const insights = { postDetail: jest.fn() };
  const POST = '22222222-2222-4222-8222-222222222222';
  const url = (post = POST, channel = '7') =>
    `/insights/workspaces/${WS}/posts/${post}/channels/${channel}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InsightsController],
      providers: [
        WorkspaceRoleGuard,
        { provide: WorkspaceRoleService, useValue: roles },
        { provide: InsightsService, useValue: insights },
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
    await app.init();
  });
  afterAll(() => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    roles.getRole.mockResolvedValue('GUEST');
    roles.isPlatformSuperAdmin.mockResolvedValue(false);
    insights.postDetail.mockResolvedValue({ ok: true });
  });

  it('a non-member gets 403', async () => {
    roles.getRole.mockResolvedValue(null);
    await request(app.getHttpServer()).get(url()).expect(403);
    expect(insights.postDetail).not.toHaveBeenCalled();
  });

  it('lets a guest read it, passing the parsed ids through', async () => {
    await request(app.getHttpServer()).get(url()).expect(200, { ok: true });
    expect(insights.postDetail).toHaveBeenCalledWith(WS, POST, 7);
  });

  it('another workspace post is the service 404, not a leak', async () => {
    insights.postDetail.mockRejectedValue(new NotFoundException());
    await request(app.getHttpServer()).get(url()).expect(404);
  });

  it('rejects a post id that is not a uuid and a channel id that is not an integer', async () => {
    await request(app.getHttpServer()).get(url('metrics-ish')).expect(400);
    await request(app.getHttpServer()).get(url(POST, 'abc')).expect(400);
    await request(app.getHttpServer()).get(url(POST, '1.5')).expect(400);
    expect(insights.postDetail).not.toHaveBeenCalled();
  });
});

describe('InsightsController next-step hiding over HTTP', () => {
  let app: INestApplication<App>;
  const OTHER_WS = '22222222-2222-4222-8222-222222222222';
  const POST = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';
  const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
  const insights = { hideStep: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InsightsController],
      providers: [
        WorkspaceRoleGuard,
        { provide: WorkspaceRoleService, useValue: roles },
        { provide: InsightsService, useValue: insights },
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
    // A guest can see Insights, so a guest can hide a card for themselves.
    roles.getRole.mockResolvedValue('GUEST');
    roles.isPlatformSuperAdmin.mockResolvedValue(false);
    insights.hideStep.mockResolvedValue(undefined);
  });

  const hide = (id: string, body: unknown, ws = WS) =>
    request(app.getHttpServer())
      .post(
        `/insights/workspaces/${ws}/next-steps/${encodeURIComponent(id)}/hide`,
      )
      .send(body as object);

  it.each([
    ['format_gap', 'not_useful'],
    ['quiet_channel:12', 'later'],
    [`repost_hit:${POST}:7`, 'not_useful'],
  ])(
    'answers 204 to hiding %s (%s), for the signed-in user',
    async (id, reason) => {
      await hide(id, { reason }).expect(204);
      expect(insights.hideStep).toHaveBeenCalledWith(WS, 'user-1', id, reason);
    },
  );

  it.each([
    ['nonsense'],
    ['quiet_channel:'],
    ['quiet_channel:12:3'],
    ['repost_hit:nope:7'],
    [`repost_hit:${POST}`],
  ])('answers 400 to the step id %s', async (id) => {
    await hide(id, { reason: 'later' }).expect(400);
    expect(insights.hideStep).not.toHaveBeenCalled();
  });

  it.each([
    [{}],
    [{ reason: 'forever' }],
    [{ reason: 'later', extra: 1 }],
    [{ reason: 30 }],
  ])('answers 400 to the body %j', async (body) => {
    await hide('format_gap', body).expect(400);
    expect(insights.hideStep).not.toHaveBeenCalled();
  });

  it('refuses a non-member with 403', async () => {
    roles.getRole.mockResolvedValue(null);
    await hide('format_gap', { reason: 'later' }).expect(403);
    expect(insights.hideStep).not.toHaveBeenCalled();
  });

  it('another workspace id is another membership: a member of one cannot hide into the other', async () => {
    roles.getRole.mockImplementation((ws: string) =>
      Promise.resolve(ws === WS ? 'GUEST' : null),
    );
    await hide('format_gap', { reason: 'later' }, OTHER_WS).expect(403);
    expect(insights.hideStep).not.toHaveBeenCalled();
    await hide('format_gap', { reason: 'later' }, WS).expect(204);
    expect(insights.hideStep).toHaveBeenCalledWith(
      WS,
      'user-1',
      'format_gap',
      'later',
    );
  });

  it('rejects a workspace id that is not a uuid', async () => {
    await hide('format_gap', { reason: 'later' }, 'probe').expect(400);
    expect(insights.hideStep).not.toHaveBeenCalled();
  });
});
