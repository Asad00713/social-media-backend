import { INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Webhook } from 'svix';
import { SKIP_LAUNCH_GATE } from '../../auth/decorators/skip-launch-gate.decorator';
import { EmailSuppressionRepository } from '../suppression/email-suppression.repository';
import { ResendWebhookController } from './resend-webhook.controller';

/** A svix secret: `whsec_` + base64 of the key bytes. */
const SECRET = `whsec_${Buffer.from('resend-webhook-spec-key-0123456789').toString('base64')}`;
const URL = '/email/webhooks/resend';

describe('ResendWebhookController over HTTP', () => {
  let app: INestApplication<App>;
  let secret: string | undefined;
  const suppressions = { suppress: jest.fn(() => Promise.resolve()) };
  const config = {
    get: jest.fn((k: string) =>
      k === 'RESEND_WEBHOOK_SECRET' ? secret : undefined,
    ),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ResendWebhookController],
      providers: [
        { provide: ConfigService, useValue: config },
        { provide: EmailSuppressionRepository, useValue: suppressions },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    secret = SECRET;
    jest.clearAllMocks();
  });

  /** The body exactly as Resend would send it, signed with `key`. */
  function signed(event: unknown, key = SECRET, id = 'msg_1') {
    const body = JSON.stringify(event);
    const now = new Date();
    const signature = new Webhook(key).sign(id, now, body);
    return {
      body,
      headers: {
        'content-type': 'application/json',
        'svix-id': id,
        'svix-timestamp': String(Math.floor(now.getTime() / 1000)),
        'svix-signature': signature,
      },
    };
  }

  const send = (s: { body: string; headers: Record<string, string> }) =>
    request(app.getHttpServer()).post(URL).set(s.headers).send(s.body);

  const bounced = (type: string | undefined, to = ['a@acme.com']) => ({
    type: 'email.bounced',
    created_at: '2026-11-14T10:00:00.000Z',
    data: {
      email_id: 'em_1',
      to,
      ...(type ? { bounce: { type, subType: 'General' } } : {}),
    },
  });

  it('webhook: bad signature → 400, no suppression', async () => {
    const good = signed(bounced('Permanent'));
    const otherKey = `whsec_${Buffer.from('some-other-key-0123456789abcdefgh').toString('base64')}`;
    const forged = signed(bounced('Permanent'), otherKey);
    const tampered = {
      ...good,
      body: good.body.replace('a@acme.com', 'victim@acme.com'),
    };
    const noHeaders = { body: good.body, headers: {} };
    for (const s of [forged, tampered, noHeaders]) {
      const res = await send(s);
      expect(res.status).toBe(400);
    }
    expect(suppressions.suppress).not.toHaveBeenCalled();
  });

  it('webhook: a malformed secret is a 503 and one error log without the secret, not a 400', async () => {
    const bad = 'whsec_not base64 !!';
    secret = bad;
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const res = await send(signed(bounced('Permanent')));
    const noHeaders = await request(app.getHttpServer()).post(URL).send({});
    const logged = JSON.stringify(error.mock.calls);
    error.mockRestore();
    expect(res.status).toBe(503);
    expect(noHeaders.status).toBe(503);
    expect(logged).toContain('RESEND_WEBHOOK_SECRET');
    expect(logged).not.toContain(bad);
    expect(suppressions.suppress).not.toHaveBeenCalled();
  });

  it('webhook: an old timestamp is refused as a replay', async () => {
    const body = JSON.stringify(bounced('Permanent'));
    const old = new Date(Date.now() - 60 * 60 * 1000);
    const res = await request(app.getHttpServer())
      .post(URL)
      .set({
        'content-type': 'application/json',
        'svix-id': 'msg_old',
        'svix-timestamp': String(Math.floor(old.getTime() / 1000)),
        'svix-signature': new Webhook(SECRET).sign('msg_old', old, body),
      })
      .send(body);
    expect(res.status).toBe(400);
    expect(suppressions.suppress).not.toHaveBeenCalled();
  });

  it('webhook: no secret → 503', async () => {
    secret = undefined;
    const res = await send(signed(bounced('Permanent')));
    expect(res.status).toBe(503);
    expect(suppressions.suppress).not.toHaveBeenCalled();
  });

  it('webhook: email.bounced Permanent suppresses each recipient; Transient does not', async () => {
    const permanent = await send(
      signed(bounced('Permanent', ['a@acme.com', 'B@Acme.com'])),
    );
    expect(permanent.status).toBe(200);
    expect(suppressions.suppress).toHaveBeenCalledTimes(2);
    expect(suppressions.suppress).toHaveBeenCalledWith(
      'a@acme.com',
      'bounced',
      'em_1',
    );
    expect(suppressions.suppress).toHaveBeenCalledWith(
      'B@Acme.com',
      'bounced',
      'em_1',
    );

    suppressions.suppress.mockClear();
    const transient = await send(signed(bounced('Transient')));
    expect(transient.status).toBe(200);
    expect(transient.body).toEqual({ ignored: true });
    expect(suppressions.suppress).not.toHaveBeenCalled();
  });

  it('webhook: a redelivered svix-id (same payload twice) is harmless', async () => {
    const delivery = signed(bounced('Permanent'), SECRET, 'msg_same');
    expect((await send(delivery)).status).toBe(200);
    expect((await send(delivery)).status).toBe(200);
    // suppress() is an upsert on the address, so the repeat rewrites one row.
    expect(suppressions.suppress).toHaveBeenCalledTimes(2);
    for (const call of suppressions.suppress.mock.calls) {
      expect(call).toEqual(['a@acme.com', 'bounced', 'em_1']);
    }
  });

  it('webhook: a bounce of an unclassified type suppresses', async () => {
    await send(signed(bounced('Undetermined')));
    await send(signed(bounced(undefined)));
    expect(suppressions.suppress).toHaveBeenCalledTimes(2);
  });

  it('webhook: email.complained suppresses', async () => {
    const res = await send(
      signed({
        type: 'email.complained',
        data: { email_id: 'em_2', to: ['c@acme.com'] },
      }),
    );
    expect(res.status).toBe(200);
    expect(suppressions.suppress).toHaveBeenCalledWith(
      'c@acme.com',
      'complained',
      'em_2',
    );
  });

  it('webhook: any other event is acknowledged and ignored', async () => {
    for (const type of ['email.delivered', 'email.opened', 'email.sent']) {
      const res = await send(
        signed({ type, data: { email_id: 'em_3', to: ['d@acme.com'] } }),
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ignored: true });
    }
    expect(suppressions.suppress).not.toHaveBeenCalled();
  });

  it('webhook: skips a recipient that is not an address and a malformed list', async () => {
    await send(signed(bounced('Permanent', [5 as never, '', 'ok@acme.com'])));
    expect(suppressions.suppress).toHaveBeenCalledTimes(1);
    suppressions.suppress.mockClear();
    const noList = await send(
      signed({ type: 'email.bounced', data: { email_id: 'x', to: 'a@b.co' } }),
    );
    expect(noList.status).toBe(200);
    expect(suppressions.suppress).not.toHaveBeenCalled();
  });

  it('webhook: a failed write answers 500 so Resend retries the delivery', async () => {
    const quiet = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    suppressions.suppress.mockRejectedValueOnce(new Error('db down'));
    const res = await send(signed(bounced('Permanent')));
    quiet.mockRestore();
    expect(res.status).toBe(500);
  });

  it('opts the controller out of the launch gate', () => {
    expect(
      new Reflector().get<boolean>(SKIP_LAUNCH_GATE, ResendWebhookController),
    ).toBe(true);
  });
});
