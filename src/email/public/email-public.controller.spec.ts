import { createHmac, randomUUID } from 'crypto';
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
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { users } from '../../drizzle/schema/users.schema';
import { ReportTokensService } from '../../insights/reports/report-tokens.service';
import { NotificationPreferencesService } from '../../notification-preferences/notification-preferences.service';
import { UsersService } from '../../users/users.service';
import { AppLinks } from '../links/app-links';
import { EmailTokensService } from '../tokens/email-tokens.service';
import { EmailPublicController } from './email-public.controller';

const SECRET = 'email-public-controller-spec-secret';
/** A fresh user per test: the POST throttle is per token, and a token is the same for the same claims within a second. */
let uid = randomUUID();
const WS = '11111111-1111-4111-8111-111111111111';
const WS_NAME = 'Acme <Q4> & co';
const PREFS_KEY = createHmac('sha256', SECRET)
  .update('email-prefs-tokens')
  .digest('base64url');

/** A route the launch gate does guard, to prove the gate is live in this app. */
@Controller('control')
class ControlController {
  @Get()
  ok() {
    return { ok: true };
  }
}

describe('EmailPublicController over HTTP', () => {
  let app: INestApplication<App>;
  let tokens: EmailTokensService;
  let jwt: JwtService;
  let ipSeq = 0;
  let userExists: boolean;
  let workspaceExists: boolean;
  const savedAllowlist = process.env.ALLOWLIST_EMAILS;

  const prefs = { disableEmail: jest.fn(() => Promise.resolve()) };
  /** `select ... from users|workspace where ... limit 1`, by table. */
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: () =>
            Promise.resolve(
              table === users
                ? userExists
                  ? [{ id: uid }]
                  : []
                : workspaceExists
                  ? [{ name: WS_NAME }]
                  : [],
            ),
        }),
      }),
    }),
  };
  const users_ = {
    findOneWithSuspension: jest.fn(() => Promise.resolve({ role: 'USER' })),
  };
  const config = {
    get: jest.fn((k: string) =>
      k === 'JWT_ACCESS_SECRET'
        ? SECRET
        : k === 'FRONTEND_URL'
          ? 'https://app.example'
          : undefined,
    ),
  };

  beforeAll(async () => {
    process.env.ALLOWLIST_EMAILS = 'owner@example.com';
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
        JwtModule.register({}),
      ],
      controllers: [EmailPublicController, ControlController],
      providers: [
        EmailTokensService,
        AppLinks,
        { provide: NotificationPreferencesService, useValue: prefs },
        { provide: DRIZZLE, useValue: db },
        { provide: ConfigService, useValue: config },
        { provide: UsersService, useValue: users_ },
        { provide: APP_GUARD, useClass: AllowlistGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
    tokens = app.get(EmailTokensService);
    jwt = app.get(JwtService);
  });

  afterAll(async () => {
    if (savedAllowlist === undefined) delete process.env.ALLOWLIST_EMAILS;
    else process.env.ALLOWLIST_EMAILS = savedAllowlist;
    await app.close();
  });

  beforeEach(() => {
    uid = randomUUID();
    userExists = true;
    workspaceExists = true;
    jest.clearAllMocks();
  });

  /** A caller address nobody else in this file has used. */
  const freshIp = () =>
    `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${++ipSeq & 255}`;
  const server = () => app.getHttpServer();
  const get = (path: string, ip = freshIp()) =>
    request(server()).get(path).set('X-Forwarded-For', ip);
  const post = (path: string, ip = freshIp()) =>
    request(server()).post(path).set('X-Forwarded-For', ip);
  const path = (token: string) => `/email/unsubscribe/${token}`;
  const mint = (
    ev:
      | 'post_failed'
      | 'member_activity'
      | 'billing_alert'
      | 'draft_ready'
      | 'inactivity_reminder' = 'member_activity',
    ws: string | null = WS,
  ) => tokens.unsubscribeToken({ uid, ws, ev });

  describe('GET (a link scanner prefetches it)', () => {
    it('GET unsubscribe does not call disableEmail (scanner prefetch)', async () => {
      const res = await get(path(mint()));
      expect(res.status).toBe(200);
      expect(prefs.disableEmail).not.toHaveBeenCalled();
    });

    it('asks first: the confirm page names the email and the workspace, escaped, and posts to itself', async () => {
      const token = mint();
      const res = await get(path(token));
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.text).toContain('Stop these emails?');
      expect(res.text).toContain(
        'Stop &quot;Member joined&quot; emails for Acme &lt;Q4&gt; &amp; co?',
      );
      expect(res.text).not.toContain('<Q4>');
      expect(res.text).toContain('Stop emails');
      expect(res.text).toContain(
        `<form method="post" action="/email/unsubscribe/${token}"`,
      );
    });

    it('says "your account" for an account-level email', async () => {
      const res = await get(path(mint('inactivity_reminder', null)));
      expect(res.text).toContain(
        'Stop &quot;Inactivity reminders&quot; emails for your account?',
      );
    });

    it('changes nothing for a locked or no-email event either, and offers no button', async () => {
      for (const ev of ['billing_alert', 'draft_ready'] as const) {
        const res = await get(path(mint(ev)));
        expect(res.status).toBe(200);
        expect(res.text).toContain('This email can&#39;t be turned off');
        expect(res.text).not.toContain('<form');
      }
      expect(prefs.disableEmail).not.toHaveBeenCalled();
    });
  });

  describe('POST (the one-click action)', () => {
    it('POST unsubscribe disables exactly (uid, ws, ev) email and answers 200 with the done page', async () => {
      const res = await post(path(mint('post_failed')));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(prefs.disableEmail).toHaveBeenCalledTimes(1);
      expect(prefs.disableEmail).toHaveBeenCalledWith(uid, WS, 'post_failed');
      expect(res.text).toContain('You&#39;re unsubscribed');
      expect(res.text).toContain(
        'You won&#39;t get &quot;Post failed&quot; emails for Acme &lt;Q4&gt; &amp; co any more.',
      );
      expect(res.text).toContain('Manage notifications');
      expect(res.text).toContain(
        'href="https://app.example/w/11111111-1111-4111-8111-111111111111/settings/notifications"',
      );
    });

    it('an account-level POST says "your account" and links nowhere', async () => {
      const res = await post(path(mint('inactivity_reminder', null)));
      expect(res.status).toBe(200);
      expect(prefs.disableEmail).toHaveBeenCalledWith(
        uid,
        null,
        'inactivity_reminder',
      );
      expect(res.text).toContain('emails for your account any more.');
      expect(res.text).not.toContain('<a ');
    });

    it('takes the RFC 8058 one-click body, twice, and a multipart body', async () => {
      const p = path(mint());
      const form = () =>
        post(p).type('form').send('List-Unsubscribe=One-Click');
      expect((await form()).status).toBe(200);
      expect((await form()).status).toBe(200);
      expect(prefs.disableEmail).toHaveBeenCalledTimes(2);
      expect(
        (await post(p).field('List-Unsubscribe', 'One-Click')).status,
      ).toBe(200);
    });

    it('only ever acts on the token, never on a user, workspace or event from the body or query', async () => {
      const res = await post(`${path(mint('post_failed'))}?uid=x&ws=y`).send({
        uid: 'victim',
        ws: 'other',
        ev: 'billing_alert',
      });
      expect(res.status).toBe(200);
      expect(prefs.disableEmail).toHaveBeenCalledTimes(1);
      expect(prefs.disableEmail).toHaveBeenCalledWith(uid, WS, 'post_failed');
    });

    it('a locked or no-email event is answered truthfully: not unsubscribed, nothing written', async () => {
      for (const ev of ['billing_alert', 'draft_ready'] as const) {
        const res = await post(path(mint(ev)));
        expect(res.status).toBe(200);
        expect(res.text).toContain('This email can&#39;t be turned off');
        expect(res.text).toContain('there is nothing to unsubscribe from');
        expect(res.text).not.toContain('unsubscribed');
      }
      expect(prefs.disableEmail).not.toHaveBeenCalled();
    });
  });

  describe('a bad link', () => {
    const invalid = [
      ['a tampered token', () => `${mint().slice(0, -3)}abc`],
      [
        'a report-unsubscribe token',
        () =>
          new ReportTokensService(
            jwt,
            config as unknown as ConfigService,
          ).unsubscribeToken(uid, 'a@b.co'),
      ],
      ['a security token', () => tokens.securityToken({ uid, act: 'not_me' })],
      [
        'a login token',
        () =>
          jwt.sign(
            { sub: uid, uid: uid, ws: WS, ev: 'post_failed' },
            { secret: SECRET },
          ),
      ],
      [
        'a token for an unknown event',
        () =>
          jwt.sign(
            { uid, ws: WS, ev: 'nope' },
            { secret: PREFS_KEY, audience: 'email-unsubscribe' },
          ),
      ],
      ['garbage', () => 'abc.def.ghi'],
    ] as const;

    it.each(invalid)(
      'POST with %s is 404 and changes nothing',
      async (_label, make) => {
        const p = path(make());
        for (const res of [await get(p), await post(p)]) {
          expect(res.status).toBe(404);
          expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
          expect(res.headers['cache-control']).toBe('private, no-store');
          expect(res.text).toContain('This link doesn&#39;t work');
        }
        expect(prefs.disableEmail).not.toHaveBeenCalled();
      },
    );

    it('a deleted user or workspace is the same 404 and changes nothing', async () => {
      const p = path(mint());
      userExists = false;
      expect((await post(p)).status).toBe(404);
      expect((await get(p)).status).toBe(404);
      userExists = true;
      workspaceExists = false;
      expect((await post(p)).status).toBe(404);
      expect((await get(p)).status).toBe(404);
      expect(prefs.disableEmail).not.toHaveBeenCalled();
    });
  });

  describe('responses', () => {
    it('are private, no-store, noindex and framing-proof on every answer, a 500 included', async () => {
      const ok = await get(path(mint()));
      const done = await post(path(mint()));
      const missing = await post(path('abc.def.ghi'));
      const quiet = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      prefs.disableEmail.mockRejectedValueOnce(new Error('db down'));
      const boom = await post(path(mint()));
      quiet.mockRestore();
      expect(boom.status).toBe(500);
      for (const res of [ok, done, missing, boom]) {
        expect(res.headers['cache-control']).toBe('private, no-store');
        expect(res.headers['x-robots-tag']).toBe('noindex');
        expect(res.headers['content-security-policy']).toContain(
          "frame-ancestors 'none'",
        );
      }
    });
  });

  describe('throttling', () => {
    it('limits GET to 10 a minute per forwarded address', async () => {
      const p = path(mint());
      for (let i = 0; i < 10; i++) {
        expect((await get(p, '4.4.4.4')).status).toBe(200);
      }
      expect((await get(p, '4.4.4.4')).status).toBe(429);
      expect((await get(p, '5.5.5.5')).status).toBe(200);
    });

    it('limits POST to 10 a minute per token, from any address', async () => {
      const p = path(mint('post_failed'));
      for (let i = 0; i < 10; i++) {
        expect((await post(p)).status).toBe(200);
      }
      expect((await post(p)).status).toBe(429);
      expect((await post(path(mint('member_activity')))).status).toBe(200);
    });
  });

  describe('a signed-out visitor', () => {
    it('gets through with a validly signed login token of a non-allowlisted user, where the launch gate is live', async () => {
      const bearer = `Bearer ${jwt.sign(
        { sub: 'u9', email: 'stranger@example.com' },
        { secret: SECRET },
      )}`;
      const control = await get('/control').set('Authorization', bearer);
      expect(control.status).toBe(403);
      expect((control.body as { code?: string }).code).toBe('NOT_LAUNCHED');
      expect(
        (await get(path(mint())).set('Authorization', bearer)).status,
      ).toBe(200);
      expect(
        (await post(path(mint())).set('Authorization', bearer)).status,
      ).toBe(200);
    });

    it('opts the controller out of the launch gate', () => {
      expect(
        new Reflector().get<boolean>(SKIP_LAUNCH_GATE, EmailPublicController),
      ).toBe(true);
    });
  });
});
