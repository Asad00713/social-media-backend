import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { SiteVerificationController } from './site-verification.controller';

describe('SiteVerificationController', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SiteVerificationController],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the TikTok verification file at the domain root as plain text', async () => {
    const res = await request(app.getHttpServer())
      .get('/tiktokBWGOXBTMJ4RXb76i56qZc99OfEZIAzIi.txt')
      .expect(200);

    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toBe(
      'tiktok-developers-site-verification=BWGOXBTMJ4RXb76i56qZc99OfEZIAzIi',
    );
  });
});
