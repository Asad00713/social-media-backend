import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { REQUIRE_CAPABILITY } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { WorkspaceRoleService } from '../workspace-members/workspace-role.service';
import { PLANNER_PREF_DEFAULTS } from './lib/planner-prefs';
import { PlannerPreferencesController } from './planner-preferences.controller';
import { PlannerPreferencesService } from './services/planner-preferences.service';

const WS = '11111111-1111-4111-8111-111111111111';
const CAL = '44444444-4444-4444-8444-444444444444';

describe('PlannerPreferencesController over HTTP', () => {
  let app: INestApplication<App>;
  const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
  const prefs = { get: jest.fn(), update: jest.fn() };
  const url = (ws = WS) => `/planner/workspaces/${ws}/preferences`;
  const put = (body: unknown, ws = WS) =>
    request(app.getHttpServer())
      .put(url(ws))
      .send(body as object);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PlannerPreferencesController],
      providers: [
        WorkspaceRoleGuard,
        { provide: WorkspaceRoleService, useValue: roles },
        { provide: PlannerPreferencesService, useValue: prefs },
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
    roles.getRole.mockResolvedValue('MEMBER');
    roles.isPlatformSuperAdmin.mockResolvedValue(false);
    prefs.get.mockResolvedValue(PLANNER_PREF_DEFAULTS);
    prefs.update.mockResolvedValue(PLANNER_PREF_DEFAULTS);
  });

  it('GET returns the prefs of the caller in this workspace', async () => {
    await request(app.getHttpServer())
      .get(url())
      .expect(200, PLANNER_PREF_DEFAULTS);
    expect(prefs.get).toHaveBeenCalledWith('user-1', WS);
  });

  it('PUT passes the caller id (never a body field) and the patch', async () => {
    await put({ colorBy: 'channel', show: { media: false } }).expect(200);
    expect(prefs.update).toHaveBeenCalledWith(
      'user-1',
      WS,
      expect.objectContaining({ colorBy: 'channel', show: { media: false } }),
    );
  });

  it('rejects a userId in the body, so it can never pick the row', async () => {
    await put({ userId: 'someone-else', colorBy: 'channel' }).expect(400);
    expect(prefs.update).not.toHaveBeenCalled();
  });

  it('lets a GUEST read and write their own preferences', async () => {
    roles.getRole.mockResolvedValue('GUEST');
    await request(app.getHttpServer()).get(url()).expect(200);
    await put({ postSize: 'compact' }).expect(200);
    expect(prefs.update).toHaveBeenCalledWith(
      'user-1',
      WS,
      expect.objectContaining({ postSize: 'compact' }),
    );
  });

  it('answers 403 to a non-member on both', async () => {
    roles.getRole.mockResolvedValue(null);
    await request(app.getHttpServer()).get(url()).expect(403);
    await put({ postSize: 'compact' }).expect(403);
    expect(prefs.get).not.toHaveBeenCalled();
    expect(prefs.update).not.toHaveBeenCalled();
  });

  it('answers 400 to a non-UUID workspace id', async () => {
    await request(app.getHttpServer()).get(url('abc')).expect(400);
    await put({}, 'abc').expect(400);
  });

  it('accepts an empty body', async () => {
    await put({}).expect(200);
  });

  it.each([
    [{ unknownKey: 1 }],
    [{ show: { bogus: true } }],
    [{ show: { media: 'yes' } }],
    [{ weekStartsOn: 2 }],
    [{ weekStartsOn: '1' }],
    [{ postSize: 'huge' }],
    [{ colorBy: 'size' }],
    [{ publishedPosts: 'gone' }],
    [{ eventDisplay: 'x' }],
    [{ bestTimesSource: 'x' }],
    [{ bestTimesInWeek: 'no' }],
    [{ suggestBestTime: 1 }],
    [{ visibleCalendarIds: ['x'] }],
    [{ visibleCalendarIds: 'x' }],
    [{ visibleCalendarIds: Array.from({ length: 51 }, () => CAL) }],
  ])('answers 400 to %j', async (body) => {
    await put(body).expect(400);
    expect(prefs.update).not.toHaveBeenCalled();
  });

  it.each([
    [{ weekStartsOn: 0 }],
    [{ weekStartsOn: 1 }],
    [{ visibleCalendarIds: null }],
    [{ visibleCalendarIds: [] }],
    [{ visibleCalendarIds: [CAL] }],
    [{ visibleCalendarIds: Array.from({ length: 50 }, () => CAL) }],
    [{ show: { weekends: false } }],
    [
      {
        publishedPosts: 'hide',
        eventDisplay: 'busy',
        bestTimesSource: 'general',
      },
    ],
  ])('accepts %j', async (body) => {
    await put(body).expect(200);
  });

  it('capability metadata: posts:draft on both', () => {
    const cap = (n: keyof PlannerPreferencesController) =>
      Reflect.getMetadata(
        REQUIRE_CAPABILITY,
        PlannerPreferencesController.prototype[n],
      ) as string | undefined;
    expect(cap('get')).toBe('posts:draft');
    expect(cap('update')).toBe('posts:draft');
  });
});
