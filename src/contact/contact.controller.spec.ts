import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppLinks } from '../email/links/app-links';
import { ContactController } from './contact.controller';
import { ContactService } from './contact.service';

const BODY = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  topic: 'billing',
  message: 'I was charged twice for the same period.',
};

describe('ContactController', () => {
  let app: INestApplication<App>;
  const submit = jest.fn();
  let ipSeq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // The app's global limit is far above the route's own 5 per 10 minutes.
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
      controllers: [ContactController],
      providers: [
        AppLinks,
        { provide: ContactService, useValue: { submit } },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'SUPPORT_EMAIL' ? 'help@us.test' : undefined,
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    submit.mockReset();
    submit.mockResolvedValue({ delivered: true });
  });

  /** A caller address nobody else in this file has used. */
  const freshIp = () => `10.9.${(ipSeq >> 8) & 255}.${++ipSeq & 255}`;
  const post = (forwardedFor: string) =>
    request(app.getHttpServer())
      .post('/contact')
      .set('X-Forwarded-For', forwardedFor)
      .send(BODY);

  it('accepts five submissions from one caller in the window and refuses the sixth', async () => {
    const ip = freshIp();

    for (let i = 0; i < 5; i++) {
      expect((await post(ip)).status).toBe(200);
    }
    const sixth = await post(ip);

    expect(sixth.status).toBe(429);
    expect(submit).toHaveBeenCalledTimes(5);
  });

  it('keeps a separate allowance for each caller address', async () => {
    const busy = freshIp();
    for (let i = 0; i < 6; i++) await post(busy);

    expect((await post(freshIp())).status).toBe(200);
    expect((await post(busy)).status).toBe(429);
  });

  it('keys on the first X-Forwarded-For entry, not the proxy address', async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) await post(`${ip}, 172.16.0.1`);

    expect((await post(`${ip}, 172.16.0.2`)).status).toBe(429);
  });

  it('answers 503 naming the configured support address when delivery fails', async () => {
    submit.mockResolvedValue({ delivered: false });

    const res = await post(freshIp());

    expect(res.status).toBe(503);
    expect((res.body as { message: string }).message).toBe(
      'We could not deliver your message right now. Please email help@us.test directly.',
    );
  });
});
