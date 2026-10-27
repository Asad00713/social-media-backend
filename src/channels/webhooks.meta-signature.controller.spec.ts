import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { WebhooksController } from './webhooks.controller';
import { InboxService } from '../inbox/inbox.service';
import { FacebookService } from './services/facebook.service';
import { InstagramService } from './services/instagram.service';
import { ChannelService } from './services/channel.service';
import { WhatsAppTemplatesService } from '../whatsapp-templates/whatsapp-templates.service';
import { QUEUES } from '../queue/queue.module';

const ENV_KEYS = [
  'META_APP_SECRET',
  'INSTAGRAM_CLIENT_SECRET',
  'THREADS_CLIENT_SECRET',
  'META_WEBHOOK_VERIFY_TOKEN',
] as const;

const sign = (secret: string, body: string) =>
  'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

describe('WebhooksController — Meta signature + verify token', () => {
  let app: INestApplication;
  let saved: Record<string, string | undefined>;
  let processMeta: jest.SpyInstance;
  let processThreads: jest.SpyInstance;

  const server = () => app.getHttpServer() as Parameters<typeof request>[0];

  async function build() {
    const queueNames = [
      QUEUES.LEAD_INTAKE,
      QUEUES.SLACK_INGEST,
      QUEUES.TELEGRAM_INGEST,
      QUEUES.WHATSAPP_INGEST,
      QUEUES.MAESTRO_BRIDGE,
    ];
    const moduleRef = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [
        { provide: InboxService, useValue: {} },
        { provide: FacebookService, useValue: {} },
        { provide: InstagramService, useValue: {} },
        { provide: ChannelService, useValue: {} },
        { provide: WhatsAppTemplatesService, useValue: {} },
        ...queueNames.map((q) => ({
          provide: getQueueToken(q),
          useValue: { add: jest.fn() },
        })),
      ],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
  }

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.META_APP_SECRET = 'app-secret';
    process.env.INSTAGRAM_CLIENT_SECRET = 'ig-secret';
    process.env.THREADS_CLIENT_SECRET = 'th-secret';
    processMeta = jest
      .spyOn(WebhooksController.prototype as any, 'processMetaWebhook')
      .mockResolvedValue(undefined);
    processThreads = jest
      .spyOn(WebhooksController.prototype as any, 'processThreadsWebhook')
      .mockResolvedValue(undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await app?.close();
  });

  const cases = [
    { source: 'instagram', secret: 'ig-secret', spy: () => processMeta },
    { source: 'facebook', secret: 'app-secret', spy: () => processMeta },
    { source: 'threads', secret: 'th-secret', spy: () => processThreads },
  ] as const;

  describe.each(cases)('POST /webhooks/$source', ({ source, secret, spy }) => {
    const payload = { object: source, entry: [] };
    const raw = JSON.stringify(payload);

    it('accepts a correctly signed delivery and processes it', async () => {
      await build();
      const res = await request(server())
        .post(`/webhooks/${source}`)
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', sign(secret, raw))
        .send(raw);
      expect(res.status).toBe(200);
      expect(res.text).toBe('EVENT_RECEIVED');
      expect(spy()).toHaveBeenCalledTimes(1);
      const [firstArg] = spy().mock.calls[0] as unknown[];
      expect(firstArg).toEqual(payload);
    });

    it('rejects an unsigned delivery', async () => {
      await build();
      const res = await request(server())
        .post(`/webhooks/${source}`)
        .set('Content-Type', 'application/json')
        .send(raw);
      expect(res.status).toBe(401);
      expect(spy()).not.toHaveBeenCalled();
    });

    it('rejects a delivery signed with the wrong secret', async () => {
      await build();
      const res = await request(server())
        .post(`/webhooks/${source}`)
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', sign('wrong', raw))
        .send(raw);
      expect(res.status).toBe(401);
      expect(spy()).not.toHaveBeenCalled();
    });
  });

  it('rejects unsigned deliveries on every endpoint when no secret is configured', async () => {
    delete process.env.META_APP_SECRET;
    delete process.env.INSTAGRAM_CLIENT_SECRET;
    delete process.env.THREADS_CLIENT_SECRET;
    await build();
    for (const source of ['instagram', 'facebook', 'threads']) {
      const res = await request(server())
        .post(`/webhooks/${source}`)
        .set('Content-Type', 'application/json')
        .send('{}');
      expect(res.status).toBe(401);
    }
    expect(processMeta).not.toHaveBeenCalled();
    expect(processThreads).not.toHaveBeenCalled();
  });

  it('refuses verification when no verify token is configured', async () => {
    await build();
    const res = await request(server()).get(
      '/webhooks/facebook?hub.mode=subscribe&hub.verify_token=webondev_verify_123&hub.challenge=x',
    );
    expect(res.status).toBe(403);
  });

  it('answers the challenge when the configured token matches', async () => {
    process.env.META_WEBHOOK_VERIFY_TOKEN = 't';
    await build();
    const res = await request(server()).get(
      '/webhooks/facebook?hub.mode=subscribe&hub.verify_token=t&hub.challenge=x',
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('x');
  });
});
