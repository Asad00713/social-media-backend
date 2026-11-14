import { createHmac } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import {
  Controller,
  Get,
  INestApplication,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { SKIP_LAUNCH_GATE } from '../../auth/decorators/skip-launch-gate.decorator';
import { AllowlistGuard } from '../../auth/guards/allowlist.guard';
import { QUEUES } from '../../queue/queue.module';
import { UsersService } from '../../users/users.service';
import { InsightsChannelsRepository } from '../insights-channels.repository';
import { GotenbergClient } from './gotenberg.client';
import {
  NoChannelsLeftError,
  ReportPayloadService,
} from './report-payload.service';
import { ReportTokensService } from './report-tokens.service';
import { ReportsPublicController } from './reports-public.controller';
import { ReportsRepository } from './reports.repository';
import { ReportsService } from './reports.service';

const SECRET = 'public-controller-spec-secret';
/** What report tokens are signed with (derived from the login secret). */
const REPORT_KEY = createHmac('sha256', SECRET)
  .update('insight-report-tokens')
  .digest('base64url');
const RID = '5d0b6f0e-1111-4222-8333-944455556666';
const WS = '11111111-1111-4111-8111-111111111111';
const NAME = 'Acme <Q4> & co';
const OFF = 'This report link is off';

/** A route the launch gate does guard, to prove the gate is live in this app. */
@Controller('control')
class ControlController {
  @Get()
  ok() {
    return { ok: true };
  }
}

describe('ReportsPublicController over HTTP', () => {
  let app: INestApplication<App>;
  let tokens: ReportTokensService;
  let jwt: JwtService;
  let shareToken: string | null;
  let reportExists: boolean;
  let ipSeq = 0;
  const savedAllowlist = process.env.ALLOWLIST_EMAILS;

  const record = () => ({
    row: {
      id: RID,
      workspaceId: WS,
      name: NAME,
      channelIds: [1],
      period: 'last_30_days',
      customFrom: null,
      customTo: null,
      compare: 'usual',
      chartMetric: 'reach',
      sections: ['totals'],
      note: null,
      logoMediaId: null,
      cadence: null,
      weekday: null,
      sendMinute: null,
      sendToTeam: false,
      recipients: [],
      attachPdf: true,
      optedOut: [],
      shareToken,
    },
    logoUrl: null,
    createdBy: null,
    updatedBy: null,
  });

  const repo = {
    byShareToken: jest.fn((t: string) =>
      Promise.resolve(
        reportExists && shareToken && t === shareToken ? record() : null,
      ),
    ),
    getById: jest.fn((id: string) =>
      Promise.resolve(reportExists && id === RID ? record() : null),
    ),
    optOut: jest.fn((id: string) =>
      Promise.resolve(
        reportExists && id === RID
          ? { reportName: NAME, workspaceName: 'Acme' }
          : null,
      ),
    ),
  };
  const payloads = {
    payload: jest.fn((_ws: string, s: { name: string }) =>
      Promise.resolve({ name: s.name }),
    ),
  };
  const users = {
    findOneWithSuspension: jest.fn(() => Promise.resolve({ role: 'USER' })),
  };
  const config = {
    get: jest.fn((k: string) =>
      k === 'JWT_ACCESS_SECRET' ? SECRET : undefined,
    ),
  };

  beforeAll(async () => {
    process.env.ALLOWLIST_EMAILS = 'owner@example.com';
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
        JwtModule.register({}),
      ],
      controllers: [ReportsPublicController, ControlController],
      providers: [
        ReportsService,
        ReportTokensService,
        { provide: ReportsRepository, useValue: repo },
        { provide: InsightsChannelsRepository, useValue: {} },
        { provide: GotenbergClient, useValue: {} },
        {
          provide: getQueueToken(QUEUES.REPORTS),
          useValue: { add: jest.fn() },
        },
        { provide: ReportPayloadService, useValue: payloads },
        { provide: ConfigService, useValue: config },
        { provide: UsersService, useValue: users },
        { provide: APP_GUARD, useClass: AllowlistGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
    tokens = app.get(ReportTokensService);
    jwt = app.get(JwtService);
  });

  afterAll(async () => {
    if (savedAllowlist === undefined) delete process.env.ALLOWLIST_EMAILS;
    else process.env.ALLOWLIST_EMAILS = savedAllowlist;
    await app.close();
  });

  beforeEach(() => {
    shareToken = ReportsService.newShareToken();
    reportExists = true;
    jest.clearAllMocks();
  });

  afterEach(() => jest.useRealTimers());

  /** A caller address nobody else in this file has used. */
  const freshIp = () =>
    `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${++ipSeq & 255}`;
  const server = () => app.getHttpServer();
  const get = (path: string, ip = freshIp()) =>
    request(server()).get(path).set('X-Forwarded-For', ip);
  const post = (path: string, ip = freshIp()) =>
    request(server()).post(path).set('X-Forwarded-For', ip);
  const later = (seconds: number) => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date(Date.now() + seconds * 1000));
  };
  const unsubPath = (token: string) => `/reports/unsubscribe/${token}`;
  const mint = (email: string) => tokens.unsubscribeToken(RID, email);

  describe('a share link turned off (Review Focus 1)', () => {
    it('404s the old link at once, keeps a minted render token for five minutes and no longer', async () => {
      const old = shareToken as string;
      const render = tokens.renderToken(RID);
      expect((await get(`/reports/public/${old}`)).status).toBe(200);

      shareToken = null;

      const off = await get(`/reports/public/${old}`);
      expect(off.status).toBe(404);
      expect(off.body).toMatchObject({ message: OFF });
      expect((await get(`/reports/render/${render}`)).status).toBe(200);

      later(301);
      const expired = await get(`/reports/render/${render}`);
      expect(expired.status).toBe(404);
      expect(expired.body).toMatchObject({ message: OFF });
    });

    it('answers a render token for a deleted report with the same 404', async () => {
      const render = tokens.renderToken(RID);
      reportExists = false;
      const res = await get(`/reports/render/${render}`);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ message: OFF });
    });

    it('answers 404 to a bad render token, an unsubscribe token and a login token', async () => {
      const login = jwt.sign(
        { sub: 'u1', email: 'a@b.co' },
        { secret: SECRET },
      );
      for (const t of ['abc.def.ghi', mint('a@b.co'), login]) {
        const res = await get(`/reports/render/${t}`);
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({ message: OFF });
      }
      expect(payloads.payload).not.toHaveBeenCalled();
    });
  });

  describe('a signed-out visitor (Review Focus 5)', () => {
    const stranger = () =>
      jwt.sign(
        { sub: 'u9', email: 'stranger@example.com' },
        { secret: SECRET },
      );

    it('gets 200 with no Authorization header', async () => {
      const res = await get(`/reports/public/${shareToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ name: NAME });
    });

    it('gets 200 with a garbage Bearer', async () => {
      const res = await get(`/reports/public/${shareToken}`).set(
        'Authorization',
        'Bearer garbage',
      );
      expect(res.status).toBe(200);
    });

    it('gets 200 with a validly signed login token of a non-allowlisted user, where the launch gate is live', async () => {
      const bearer = `Bearer ${stranger()}`;
      const control = await get('/control').set('Authorization', bearer);
      expect(control.status).toBe(403);
      expect((control.body as { code?: string }).code).toBe('NOT_LAUNCHED');

      const pub = await get(`/reports/public/${shareToken}`).set(
        'Authorization',
        bearer,
      );
      expect(pub.status).toBe(200);
      const render = await get(
        `/reports/render/${tokens.renderToken(RID)}`,
      ).set('Authorization', bearer);
      expect(render.status).toBe(200);
      const unsub = await get(unsubPath(mint('x@y.co'))).set(
        'Authorization',
        bearer,
      );
      expect(unsub.status).toBe(200);
    });

    it('opts the controller out of the launch gate', () => {
      expect(
        new Reflector().get<boolean>(SKIP_LAUNCH_GATE, ReportsPublicController),
      ).toBe(true);
    });
  });

  describe('responses', () => {
    it('are private, no-store and noindex on a 200 and on a 404', async () => {
      const ok = await get(`/reports/public/${shareToken}`);
      const missing = await get(
        `/reports/public/${ReportsService.newShareToken()}`,
      );
      expect(ok.status).toBe(200);
      expect(missing.status).toBe(404);
      for (const res of [ok, missing]) {
        expect(res.headers['cache-control']).toBe('private, no-store');
        expect(res.headers['x-robots-tag']).toBe('noindex');
      }
      const render = await get(`/reports/render/nope`);
      expect(render.status).toBe(404);
      expect(render.headers['cache-control']).toBe('private, no-store');
      expect(render.headers['x-robots-tag']).toBe('noindex');
    });

    it('still carries the headers when the service throws', async () => {
      // Nest's ExceptionsHandler logs each of the four on purpose; keep it quiet.
      const quiet = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const boom = new Error('db down');
      repo.byShareToken.mockRejectedValueOnce(boom);
      repo.getById.mockRejectedValueOnce(boom);
      const path = unsubPath(mint('boom@acme.com'));
      const hits = [
        await get(`/reports/public/${shareToken}`),
        await get(`/reports/render/${tokens.renderToken(RID)}`),
      ];
      repo.getById.mockRejectedValueOnce(boom);
      hits.push(await get(path));
      repo.optOut.mockRejectedValueOnce(boom);
      hits.push(await post(path));
      for (const res of hits) {
        expect(res.status).toBe(500);
        expect(res.headers['cache-control']).toBe('private, no-store');
        expect(res.headers['x-robots-tag']).toBe('noindex');
      }
      expect(hits[2].headers['content-security-policy']).toContain(
        "frame-ancestors 'none'",
      );
      expect(hits[3].headers['content-security-policy']).toContain(
        "frame-ancestors 'none'",
      );
      quiet.mockRestore();
    });

    it('answers 409 when every channel is gone', async () => {
      payloads.payload.mockRejectedValueOnce(new NoChannelsLeftError());
      const pub = await get(`/reports/public/${shareToken}`);
      expect(pub.status).toBe(409);
      expect(pub.body).toMatchObject({
        message: 'No channels left in this report',
      });
      expect(pub.headers['cache-control']).toBe('private, no-store');

      payloads.payload.mockRejectedValueOnce(new NoChannelsLeftError());
      const render = await get(`/reports/render/${tokens.renderToken(RID)}`);
      expect(render.status).toBe(409);
    });

    it('hands the payload service the stored settings of the report, not a request value', async () => {
      await get(`/reports/public/${shareToken}?channelIds=2&sections=audience`);
      expect(payloads.payload).toHaveBeenCalledTimes(1);
      const [ws, settings] = payloads.payload.mock.calls[0] as unknown as [
        string,
        { channelIds: number[]; sections: string[] },
      ];
      expect(ws).toBe(WS);
      expect(settings.channelIds).toEqual([1]);
      expect(settings.sections).toEqual(['totals']);
    });

    it('404s a token that is not a share token without asking the repository', async () => {
      const res = await get('/reports/public/abc.def.ghi');
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ message: OFF });
      expect(repo.byShareToken).not.toHaveBeenCalled();
    });
  });

  describe('throttling', () => {
    it('limits GET /reports/public/:token to 60 a minute per forwarded address', async () => {
      const path = `/reports/public/${shareToken}`;
      for (let i = 0; i < 60; i++) {
        expect((await get(path, '1.1.1.1')).status).toBe(200);
      }
      expect((await get(path, '1.1.1.1')).status).toBe(429);
      expect((await get(path, '2.2.2.2')).status).toBe(200);
    });

    it('does not limit the render route', async () => {
      const path = `/reports/render/${tokens.renderToken(RID)}`;
      for (let i = 0; i < 70; i++) {
        expect((await get(path, '3.3.3.3')).status).not.toBe(429);
      }
    });

    it('limits GET /reports/unsubscribe/:token to 10 a minute per forwarded address', async () => {
      const path = unsubPath(mint('get-limit@acme.com'));
      for (let i = 0; i < 10; i++) {
        expect((await get(path, '4.4.4.4')).status).toBe(200);
      }
      expect((await get(path, '4.4.4.4')).status).toBe(429);
      expect((await get(path, '5.5.5.5')).status).toBe(200);
    });

    it('limits POST /reports/unsubscribe/:token to 10 a minute per token, from any address', async () => {
      const path = unsubPath(mint('post-limit@acme.com'));
      for (let i = 0; i < 10; i++) {
        expect((await post(path)).status).toBe(200);
      }
      expect((await post(path)).status).toBe(429);

      const other = unsubPath(mint('another@acme.com'));
      expect((await post(other)).status).toBe(200);
    });
  });

  describe('unsubscribe', () => {
    it('GET asks first and changes nothing', async () => {
      const path = unsubPath(mint('client@acme.com'));
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['x-robots-tag']).toBe('noindex');
      expect(res.headers['content-security-policy']).toContain(
        "frame-ancestors 'none'",
      );
      expect(res.text).toContain('Stop receiving');
      expect(res.text).toContain('Acme &lt;Q4&gt; &amp; co');
      expect(res.text).not.toContain('<Q4>');
      expect(res.text).toContain(`<form method="post" action="${path}"`);
      expect(repo.optOut).not.toHaveBeenCalled();
    });

    it('POST with an empty body opts out the lowercased address in the token', async () => {
      const path = unsubPath(mint('Client@Acme.com'));
      const res = await post(path);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['content-security-policy']).toContain(
        "frame-ancestors 'none'",
      );
      expect(res.text).toContain(
        "You won't get Acme &lt;Q4&gt; &amp; co again.",
      );
      expect(repo.optOut).toHaveBeenCalledWith(RID, 'client@acme.com');
    });

    it('POST takes the RFC 8058 one-click body, twice, and a multipart body', async () => {
      const path = unsubPath(mint('onclick@acme.com'));
      const form = () =>
        post(path).type('form').send('List-Unsubscribe=One-Click');
      expect((await form()).status).toBe(200);
      expect((await form()).status).toBe(200);
      expect(repo.optOut).toHaveBeenCalledTimes(2);

      const multipart = await post(path).field('List-Unsubscribe', 'One-Click');
      expect(multipart.status).toBe(200);
    });

    it('POST only ever opts out the address inside the token, never one from the body or query', async () => {
      const path = unsubPath(mint('real@acme.com'));
      const res = await post(`${path}?email=victim@x.co`).send({
        email: 'victim2@x.co',
        reportId: 'other',
      });
      expect(res.status).toBe(200);
      expect(repo.optOut).toHaveBeenCalledTimes(1);
      expect(repo.optOut).toHaveBeenCalledWith(RID, 'real@acme.com');
    });

    describe.each([
      [
        'a tampered token',
        () => {
          const t = mint('a@acme.com');
          const [h, p, s] = t.split('.');
          return `${h}.${p}.${s.slice(0, 10)}${s[10] === 'A' ? 'B' : 'A'}${s.slice(11)}`;
        },
      ],
      ['a render token', () => tokens.renderToken(RID)],
      ['garbage', () => 'abc.def.ghi'],
    ])('%s', (_label, make) => {
      it('gets 404 HTML on GET and POST and never touches the list', async () => {
        const path = unsubPath(make());
        for (const res of [await get(path), await post(path)]) {
          expect(res.status).toBe(404);
          expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
          expect(res.headers['cache-control']).toBe('private, no-store');
          expect(res.headers['content-security-policy']).toContain(
            "frame-ancestors 'none'",
          );
          expect(res.text).toContain("This link doesn't work");
        }
        expect(repo.getById).not.toHaveBeenCalled();
        expect(repo.optOut).not.toHaveBeenCalled();
      });
    });

    it('404s a token signed with an expiry that has passed', async () => {
      const stale = jwt.sign(
        { rid: RID, email: 'a@acme.com' },
        { secret: REPORT_KEY, audience: 'report-unsubscribe', expiresIn: 1 },
      );
      later(2);
      const path = unsubPath(stale);
      expect((await get(path)).status).toBe(404);
      expect((await post(path)).status).toBe(404);
      expect(repo.optOut).not.toHaveBeenCalled();
    });

    it('404s a good token once the report is deleted', async () => {
      const path = unsubPath(mint('gone@acme.com'));
      reportExists = false;
      const g = await get(path);
      const p = await post(path);
      expect(g.status).toBe(404);
      expect(p.status).toBe(404);
      expect(g.text).toContain("This link doesn't work");
    });
  });
});
