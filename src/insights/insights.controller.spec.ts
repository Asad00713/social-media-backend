import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
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
      7,
      '16,15',
      'Asia/Karachi',
    );
  });

  it.each([
    ['overview?days=14'],
    ['overview?tz=Mars/Olympus'],
    ['posts?limit=500'],
    ['posts?sort=reach'],
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
    expect(insights.posts).toHaveBeenCalledWith(WS, 30, undefined, {
      format: 'video',
      sort: 'likes',
      order: 'asc',
      limit: 20,
      offset: 40,
    });
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
});
