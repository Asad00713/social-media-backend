import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminIncidentsController } from './admin-incidents.controller';
import { PlatformIncidentsService } from './platform-incidents.service';
import { PlatformStatusController } from './platform-status.controller';
import { PlatformStatusService } from './platform-status.service';

const INCIDENT_ID = '11111111-1111-4111-8111-111111111111';

describe('platform status over HTTP', () => {
  let app: INestApplication<App>;
  /** null = no signed-in user. */
  let role: 'USER' | 'ADMIN' | 'SUPER_ADMIN' | null = 'USER';
  const status = { getStatusPage: jest.fn() };
  const incidents = {
    list: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    resolve: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PlatformStatusController, AdminIncidentsController],
      providers: [
        { provide: PlatformStatusService, useValue: status },
        { provide: PlatformIncidentsService, useValue: incidents },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: {
          switchToHttp: () => { getRequest: () => { user?: unknown } };
        }) => {
          if (!role) return false;
          ctx.switchToHttp().getRequest().user = {
            userId: 'user-1',
            email: 'a@b.test',
            role,
          };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    // As main.ts runs it.
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
    role = 'USER';
    status.getStatusPage.mockResolvedValue({ platforms: [] });
    incidents.create.mockResolvedValue({ id: INCIDENT_ID });
    incidents.update.mockResolvedValue({ id: INCIDENT_ID });
    incidents.resolve.mockResolvedValue({ id: INCIDENT_ID });
    incidents.list.mockResolvedValue([]);
  });

  describe('GET /status', () => {
    it('answers any signed-in user', async () => {
      await request(app.getHttpServer())
        .get('/status')
        .expect(200, { platforms: [] });
    });

    it('refuses a request with no signed-in user', async () => {
      role = null;
      await request(app.getHttpServer()).get('/status').expect(403);
      expect(status.getStatusPage).not.toHaveBeenCalled();
    });
  });

  describe('/admin/status/incidents', () => {
    const body = {
      platform: 'instagram',
      severity: 'outage',
      title: '  Instagram is down ',
    };

    it.each(['USER', 'ADMIN'] as const)(
      'refuses a %s on every route',
      async (r) => {
        role = r;
        const server = app.getHttpServer();
        await request(server).get('/admin/status/incidents').expect(403);
        await request(server)
          .post('/admin/status/incidents')
          .send(body)
          .expect(403);
        await request(server)
          .patch(`/admin/status/incidents/${INCIDENT_ID}`)
          .send({ title: 'x' })
          .expect(403);
        await request(server)
          .post(`/admin/status/incidents/${INCIDENT_ID}/resolve`)
          .expect(403);
        expect(incidents.list).not.toHaveBeenCalled();
        expect(incidents.create).not.toHaveBeenCalled();
        expect(incidents.update).not.toHaveBeenCalled();
        expect(incidents.resolve).not.toHaveBeenCalled();
      },
    );

    it('lets a super admin post one, as themselves, title trimmed', async () => {
      role = 'SUPER_ADMIN';
      await request(app.getHttpServer())
        .post('/admin/status/incidents')
        .send(body)
        .expect(201);
      expect(incidents.create).toHaveBeenCalledWith('user-1', {
        platform: 'instagram',
        severity: 'outage',
        title: 'Instagram is down',
      });
    });

    it('accepts platform null (every platform)', async () => {
      role = 'SUPER_ADMIN';
      await request(app.getHttpServer())
        .post('/admin/status/incidents')
        .send({ ...body, platform: null })
        .expect(201);
    });

    it.each([
      ['an unknown platform', { ...body, platform: 'myspace' }],
      ['an unknown severity', { ...body, severity: 'meh' }],
      ['a blank title', { ...body, title: '   ' }],
      ['a 121-character title', { ...body, title: 'x'.repeat(121) }],
      ['an extra field', { ...body, createdBy: 'someone-else' }],
    ])('refuses %s', async (_label, payload) => {
      role = 'SUPER_ADMIN';
      await request(app.getHttpServer())
        .post('/admin/status/incidents')
        .send(payload)
        .expect(400);
      expect(incidents.create).not.toHaveBeenCalled();
    });

    it('refuses a non-uuid id', async () => {
      role = 'SUPER_ADMIN';
      await request(app.getHttpServer())
        .post('/admin/status/incidents/nope/resolve')
        .expect(400);
      expect(incidents.resolve).not.toHaveBeenCalled();
    });

    it('resolves and updates by id', async () => {
      role = 'SUPER_ADMIN';
      await request(app.getHttpServer())
        .post(`/admin/status/incidents/${INCIDENT_ID}/resolve`)
        .expect(200);
      expect(incidents.resolve).toHaveBeenCalledWith('user-1', INCIDENT_ID);
      await request(app.getHttpServer())
        .patch(`/admin/status/incidents/${INCIDENT_ID}`)
        .send({ severity: 'delayed' })
        .expect(200);
      expect(incidents.update).toHaveBeenCalledWith('user-1', INCIDENT_ID, {
        severity: 'delayed',
      });
    });
  });
});
