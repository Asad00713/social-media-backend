import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../workspace-members/workspace-role.guard';
import { WorkspaceRoleService } from '../../workspace-members/workspace-role.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

const WS = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const BASE = `/insights/workspaces/${WS}/reports`;

const BODY = {
  name: 'Monthly review',
  channelIds: [1],
  period: 'last_30_days',
  compare: 'usual',
  chartMetric: 'reach',
  sections: ['brief', 'totals'],
};

describe('ReportsController over HTTP', () => {
  let app: INestApplication<App>;
  const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
  const reports = {
    list: jest.fn(),
    get: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    setShare: jest.fn(),
    preview: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ReportsController],
      providers: [
        WorkspaceRoleGuard,
        { provide: WorkspaceRoleService, useValue: roles },
        { provide: ReportsService, useValue: reports },
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
    reports.list.mockResolvedValue([]);
    reports.get.mockResolvedValue({ id: ID });
    reports.create.mockResolvedValue({ id: ID });
    reports.update.mockResolvedValue({ id: ID });
    reports.remove.mockResolvedValue(undefined);
    reports.setShare.mockResolvedValue({ url: null });
    reports.preview.mockResolvedValue({ name: 'x' });
  });

  const http = () => request(app.getHttpServer());
  const routes: [string, string, string, object | null][] = [
    ['get', BASE, 'list', null],
    ['get', `${BASE}/${ID}`, 'get', null],
    ['post', BASE, 'create', BODY],
    ['patch', `${BASE}/${ID}`, 'update', { note: 'x' }],
    ['delete', `${BASE}/${ID}`, 'remove', null],
    ['post', `${BASE}/${ID}/share`, 'setShare', { enabled: true }],
    ['post', `${BASE}/preview`, 'preview', BODY],
  ];

  it.each(routes)(
    'refuses a signed-in non-member on %s %s with 403',
    async (method, url, fn, body) => {
      roles.getRole.mockResolvedValue(null);
      const call = http()[method as 'get' | 'post' | 'patch' | 'delete'](url);
      await (body ? call.send(body) : call).expect(403);
      expect(reports[fn as keyof typeof reports]).not.toHaveBeenCalled();
    },
  );

  it('lets a guest read the list and one report, and preview', async () => {
    roles.getRole.mockResolvedValue('GUEST');
    await http().get(BASE).expect(200, []);
    await http().get(`${BASE}/${ID}`).expect(200, { id: ID });
    await http().post(`${BASE}/preview`).send(BODY).expect(200);
    expect(reports.preview).toHaveBeenCalledWith(WS, expect.anything());
  });

  it('refuses a guest on create, update, delete and share', async () => {
    roles.getRole.mockResolvedValue('GUEST');
    await http().post(BASE).send(BODY).expect(403);
    await http().patch(`${BASE}/${ID}`).send({ note: 'x' }).expect(403);
    await http().delete(`${BASE}/${ID}`).expect(403);
    await http()
      .post(`${BASE}/${ID}/share`)
      .send({ enabled: true })
      .expect(403);
    expect(reports.create).not.toHaveBeenCalled();
    expect(reports.update).not.toHaveBeenCalled();
    expect(reports.remove).not.toHaveBeenCalled();
    expect(reports.setShare).not.toHaveBeenCalled();
  });

  it('lets a member create (201), update, delete (204) and share (200)', async () => {
    await http().post(BASE).send(BODY).expect(201, { id: ID });
    expect(reports.create).toHaveBeenCalledWith(
      WS,
      'user-1',
      expect.objectContaining({ name: 'Monthly review' }),
    );
    await http().patch(`${BASE}/${ID}`).send({ note: 'x' }).expect(200);
    expect(reports.update).toHaveBeenCalledWith(
      WS,
      'user-1',
      ID,
      expect.objectContaining({ note: 'x' }),
    );
    await http().delete(`${BASE}/${ID}`).expect(204);
    await http()
      .post(`${BASE}/${ID}/share`)
      .send({ enabled: true })
      .expect(200, { url: null });
    expect(reports.setShare).toHaveBeenCalledWith(WS, 'user-1', ID, true);
  });

  it('routes /preview to preview, not to :id', async () => {
    await http().post(`${BASE}/preview`).send(BODY).expect(200);
    expect(reports.get).not.toHaveBeenCalled();
  });

  it('answers 400 to an unknown body field', async () => {
    await http()
      .post(BASE)
      .send({ ...BODY, workspaceId: WS })
      .expect(400);
    await http().patch(`${BASE}/${ID}`).send({ shareToken: 'x' }).expect(400);
    await http()
      .post(`${BASE}/preview`)
      .send({ ...BODY, extra: 1 })
      .expect(400);
    await http()
      .post(`${BASE}/${ID}/share`)
      .send({ enabled: 'yes' })
      .expect(400);
    expect(reports.create).not.toHaveBeenCalled();
    expect(reports.update).not.toHaveBeenCalled();
    expect(reports.preview).not.toHaveBeenCalled();
    expect(reports.setShare).not.toHaveBeenCalled();
  });

  it('answers 400 to an empty channel list on preview', async () => {
    await http()
      .post(`${BASE}/preview`)
      .send({ ...BODY, channelIds: [] })
      .expect(400);
    expect(reports.preview).not.toHaveBeenCalled();
  });

  it('answers 400 to an id that is not a uuid', async () => {
    await http().get(`${BASE}/probe`).expect(400);
    await http().patch(`${BASE}/probe`).send({ note: 'x' }).expect(400);
    await http().delete(`${BASE}/probe`).expect(400);
    await http()
      .post(`${BASE}/probe/share`)
      .send({ enabled: true })
      .expect(400);
    await http().get('/insights/workspaces/probe/reports').expect(400);
    expect(reports.get).not.toHaveBeenCalled();
  });
});
