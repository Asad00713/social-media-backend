import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { AdminGuard } from 'src/auth/guards/admin.guard';

/**
 * Real HTTP-level test: boots a Nest app with the SAME global ValidationPipe
 * config as main.ts (`whitelist: true, forbidNonWhitelisted: true, transform:
 * true`). This is the only way to catch the whole-object-DTO-vs-per-key-query
 * bug — a unit test calling the controller method directly bypasses the pipe
 * entirely and would pass even with the broken signature.
 *
 * The DB-backed FeedbackService is stubbed since only routing/validation
 * behaviour is under test here, not persistence.
 */
describe('FeedbackController (validation pipe)', () => {
  let app: INestApplication<App>;
  const feedbackService = {
    findAllPublic: jest.fn().mockResolvedValue({ data: [], pagination: {} }),
    getStats: jest.fn().mockResolvedValue({ approved: 0, averageRating: 0 }),
    findAllAdmin: jest.fn().mockResolvedValue({ data: [], pagination: {} }),
    dismiss: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      controllers: [FeedbackController],
      providers: [{ provide: FeedbackService, useValue: feedbackService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context) => {
          const request = context.switchToHttp().getRequest();
          request.user = { userId: 'test-user-id' };
          return true;
        },
      })
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /feedback/admin', () => {
    it('does not 400 when status, limit, and type are combined', async () => {
      await request(app.getHttpServer())
        .get('/feedback/admin?status=pending&limit=100&type=app')
        .expect(200);

      expect(feedbackService.findAllAdmin).toHaveBeenCalledWith(
        1,
        100,
        'pending',
        'app',
      );
    });

    it('has no default type when absent (admins see everything)', async () => {
      await request(app.getHttpServer()).get('/feedback/admin').expect(200);

      expect(feedbackService.findAllAdmin).toHaveBeenCalledWith(
        1,
        10,
        undefined,
        undefined,
      );
    });

    it('rejects an invalid type value with 400', async () => {
      const res = await request(app.getHttpServer()).get(
        '/feedback/admin?type=bogus',
      );

      expect(res.status).toBe(400);
    });
  });

  describe('GET /feedback (public)', () => {
    it('does not 400 when page and limit are combined', async () => {
      await request(app.getHttpServer())
        .get('/feedback?page=1&limit=10')
        .expect(200);

      expect(feedbackService.findAllPublic).toHaveBeenCalledWith(1, 10, 'app');
    });

    it('defaults type to "app" when absent', async () => {
      await request(app.getHttpServer()).get('/feedback').expect(200);

      expect(feedbackService.findAllPublic).toHaveBeenCalledWith(1, 10, 'app');
    });

    it('rejects an invalid type value with 400', async () => {
      const res = await request(app.getHttpServer()).get(
        '/feedback?type=bogus',
      );

      expect(res.status).toBe(400);
    });
  });

  describe('POST /feedback/dismiss', () => {
    it('accepts a valid type', async () => {
      await request(app.getHttpServer())
        .post('/feedback/dismiss')
        .send({ type: 'app' })
        .expect(204);
    });

    it('rejects an invalid type with 400', async () => {
      await request(app.getHttpServer())
        .post('/feedback/dismiss')
        .send({ type: 'bogus' })
        .expect(400);
    });
  });
});
