import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { WorkspaceRoleService } from '../workspace-members/workspace-role.service';
import { PlannerController } from './planner.controller';
import { PlannerListService } from './services/planner-list.service';
import { PlannerLookupService } from './services/planner-lookup.service';

const WS = '11111111-1111-4111-8111-111111111111';

describe('PlannerController list over HTTP', () => {
  let app: INestApplication<App>;
  const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
  const list = { list: jest.fn() };
  const lookup = {
    monthCounts: jest.fn(),
    nextPost: jest.fn(),
    lastPostTime: jest.fn(),
  };
  const empty = {
    rows: [],
    total: 0,
    nextCursor: null,
    counts: { upcoming: 0, failed: 0 },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PlannerController],
      providers: [
        WorkspaceRoleGuard,
        { provide: WorkspaceRoleService, useValue: roles },
        { provide: PlannerListService, useValue: list },
        { provide: PlannerLookupService, useValue: lookup },
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
  });

  const get = (qs: string, ws = WS) =>
    request(app.getHttpServer()).get(`/planner/workspaces/${ws}/list${qs}`);

  it.each([
    ['', 'no tab'],
    ['?tab=nope', 'unknown tab'],
    ['?tab=all&limit=0', 'limit 0'],
    ['?tab=all&limit=101', 'limit 101'],
    ['?tab=all&limit=abc', 'limit not a number'],
    ['?tab=all&cursor=%%%', 'bad cursor'],
    ['?tab=all&extra=1', 'unknown key'],
  ])('answers 400 to %s (%s)', async (qs) => {
    await get(qs).expect(400);
    expect(list.list).not.toHaveBeenCalled();
  });

  it('answers 400 to a non-UUID workspace id', async () => {
    await get('?tab=all', 'abc').expect(400);
    expect(list.list).not.toHaveBeenCalled();
  });

  it('lets a guest list, defaulting limit to 30', async () => {
    await get('?tab=upcoming').expect(200, empty);
    expect(list.list).toHaveBeenCalledWith(WS, {
      tab: 'upcoming',
      limit: 30,
      cursor: undefined,
    });
  });

  it('answers 403 to a non-member', async () => {
    roles.getRole.mockResolvedValue(null);
    await get('?tab=all').expect(403);
    expect(list.list).not.toHaveBeenCalled();
  });

  describe('lookups', () => {
    const at = (path: string, ws = WS) =>
      request(app.getHttpServer()).get(`/planner/workspaces/${ws}/${path}`);
    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => i + 1).join(',');

    beforeEach(() => {
      lookup.monthCounts.mockResolvedValue({ months: [] });
      lookup.nextPost.mockResolvedValue({ scheduledAt: null });
      lookup.lastPostTime.mockResolvedValue({ at: null });
    });

    it.each([
      ['month-counts?year=1999'],
      ['month-counts?year=2101'],
      ['month-counts?year=abc'],
      ['month-counts'],
      ['month-counts?year=2026&tz=UTC'],
      ['next-post?after=banana'],
      ['next-post'],
      ['last-post-time?channelIds=a,b'],
      ['last-post-time'],
      ['last-post-time?channelIds=1,,2'],
      [`last-post-time?channelIds=${ids(51)}`],
    ])('answers 400 to %s', async (path) => {
      await at(path).expect(400);
      expect(lookup.monthCounts).not.toHaveBeenCalled();
      expect(lookup.nextPost).not.toHaveBeenCalled();
      expect(lookup.lastPostTime).not.toHaveBeenCalled();
    });

    it('lets a guest read all three', async () => {
      await at('month-counts?year=2026').expect(200, { months: [] });
      expect(lookup.monthCounts).toHaveBeenCalledWith(WS, 2026);
      await at('next-post?after=2026-01-01T00:00:00.000Z').expect(200, {
        scheduledAt: null,
      });
      expect(lookup.nextPost).toHaveBeenCalledWith(
        WS,
        new Date('2026-01-01T00:00:00.000Z'),
      );
      await at('last-post-time?channelIds=1,2').expect(200, { at: null });
      expect(lookup.lastPostTime).toHaveBeenCalledWith(WS, [1, 2]);
    });

    it('accepts 50 channel ids', async () => {
      await at(`last-post-time?channelIds=${ids(50)}`).expect(200);
    });

    it('answers 403 to a non-member', async () => {
      roles.getRole.mockResolvedValue(null);
      await at('month-counts?year=2026').expect(403);
      expect(lookup.monthCounts).not.toHaveBeenCalled();
    });
  });
});
