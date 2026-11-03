import { INestApplication } from '@nestjs/common';
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
    expect(insights.signals).toHaveBeenCalledWith(WS, '4,7');
    await request(app.getHttpServer())
      .get(`/insights/workspaces/${WS}/signals`)
      .expect(200);
    expect(insights.signals).toHaveBeenLastCalledWith(WS, undefined);
  });

  it('rejects a workspace id that is not a uuid', async () => {
    await request(app.getHttpServer())
      .get('/insights/workspaces/probe/signals')
      .expect(400);
    expect(insights.signals).not.toHaveBeenCalled();
  });
});
