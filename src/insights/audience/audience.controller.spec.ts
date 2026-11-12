import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import {
  customWindow,
  utcToday,
  windowOf,
} from '../../post-performance/period';
import { WorkspaceRoleGuard } from '../../workspace-members/workspace-role.guard';
import { WorkspaceRoleService } from '../../workspace-members/workspace-role.service';
import { AudienceController } from './audience.controller';
import { AudienceService } from './audience.service';

const WS = '11111111-1111-4111-8111-111111111111';
const BASE = `/insights/workspaces/${WS}/audience`;

describe('AudienceController over HTTP', () => {
  let app: INestApplication<App>;
  const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
  const audience = { growth: jest.fn(), channels: jest.fn(), csv: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AudienceController],
      providers: [
        WorkspaceRoleGuard,
        { provide: WorkspaceRoleService, useValue: roles },
        { provide: AudienceService, useValue: audience },
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
    audience.growth.mockResolvedValue({ growth: true });
    audience.channels.mockResolvedValue({ channels: [] });
    audience.csv.mockResolvedValue({
      filename: 'schedura-audience-a-b.csv',
      body: '\uFEFFx\r\n',
    });
  });

  it.each([['growth'], ['growth/export'], ['channels']])(
    'refuses a signed-in non-member on %s with 403',
    async (path) => {
      roles.getRole.mockResolvedValue(null);
      await request(app.getHttpServer()).get(`${BASE}/${path}`).expect(403);
      expect(audience.growth).not.toHaveBeenCalled();
      expect(audience.csv).not.toHaveBeenCalled();
      expect(audience.channels).not.toHaveBeenCalled();
    },
  );

  it('lets a guest read growth and channels, passing the parsed input through', async () => {
    await request(app.getHttpServer())
      .get(`${BASE}/growth?days=7&channels=16,15`)
      .expect(200, { growth: true });
    expect(audience.growth).toHaveBeenCalledWith(
      WS,
      { days: 7, window: windowOf(utcToday(new Date()), 7) },
      '16,15',
    );

    await request(app.getHttpServer())
      .get(`${BASE}/channels?from=2026-10-01&to=2026-10-14`)
      .expect(200, { channels: [] });
    expect(audience.channels).toHaveBeenCalledWith(
      WS,
      { days: 14, window: customWindow('2026-10-01', '2026-10-14') },
      undefined,
    );
  });

  it('downloads the CSV as an attachment', async () => {
    const res = await request(app.getHttpServer())
      .get(`${BASE}/growth/export?days=7`)
      .expect(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="schedura-audience-a-b.csv"',
    );
    expect(res.text.replace(/^\uFEFF/, '')).toBe('x\r\n');
    expect(audience.csv).toHaveBeenCalledWith(
      WS,
      { days: 7, window: windowOf(utcToday(new Date()), 7) },
      undefined,
    );
  });

  it.each([
    ['growth?days=14'],
    ['growth?days=7&days=7'],
    ['growth?from=2026-10-01&to=2026-10-02&from=2026-10-01'],
    ['growth?days=7&from=2026-10-01&to=2026-10-02'],
    ['growth?from=2026-10-01'],
    ['growth?channels=1&channels=2'],
    ['growth/export?days=7&days=7'],
    ['growth/export?from=2026-10-02&to=2026-10-01'],
    ['growth/export?channels=1&channels=2'],
    ['channels?days=7&days=30'],
    ['channels?to=2026-10-02'],
    ['channels?channels=1&channels=2'],
  ])('answers 400 to %s', async (path) => {
    await request(app.getHttpServer()).get(`${BASE}/${path}`).expect(400);
    expect(audience.growth).not.toHaveBeenCalled();
    expect(audience.csv).not.toHaveBeenCalled();
    expect(audience.channels).not.toHaveBeenCalled();
  });

  it('rejects a workspace id that is not a uuid', async () => {
    await request(app.getHttpServer())
      .get('/insights/workspaces/probe/audience/growth')
      .expect(400);
  });
});
