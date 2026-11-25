import { BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';
import { BillingController } from './billing.controller';
import { PaddleWebhookService } from './services/paddle-webhook.service';
import { paddleSignedPayload } from './providers/paddle-signature.util';

/**
 * The Paddle webhook ROUTE, not the service.
 *
 * Three things only the route can get wrong, and each of them fails in a way
 * that looks like something else:
 *
 * 1. **Reading the wrong header.** Paddle sends `Paddle-Signature`; Lemon
 *    Squeezy sends `x-signature`. Reading the Lemon Squeezy one here rejects
 *    every genuine delivery and reads as a bad secret.
 * 2. **Verifying a re-serialised body.** Paddle signs the exact bytes, so
 *    `JSON.parse` then `JSON.stringify` — which reorders keys and changes
 *    whitespace — fails every real webhook.
 * 3. **Parsing before verifying.** An unverified body must never be
 *    interpreted, and a forged one must be a 400 that Paddle does NOT retry,
 *    not a 500 that it retries into forever.
 *
 * The controller is constructed directly rather than through a Nest module:
 * `BillingController` takes twelve services, and this file is about four lines
 * of one route.
 */

const SECRET = 'pdl_ntfset_route_test';

function controllerWith(service: Partial<PaddleWebhookService>) {
  const stub = {} as never;
  return new BillingController(
    stub, // SubscriptionService
    stub, // WebhookService
    stub, // LemonSqueezyWebhookService
    service as PaddleWebhookService,
    stub, // UsageService
    stub, // AddonService
    stub, // PlanChangeService
    stub, // DashboardService
    stub, // InvoiceService
    stub, // PaymentMethodService
    stub, // StripeService
    stub, // BillingOverviewService
  );
}

function signedHeader(raw: Buffer, ts = String(Math.floor(Date.now() / 1000))) {
  const h1 = crypto
    .createHmac('sha256', SECRET)
    .update(paddleSignedPayload(ts, raw))
    .digest('hex');
  return `ts=${ts};h1=${h1}`;
}

describe('POST /billing/webhooks/paddle', () => {
  const OLD = process.env.PADDLE_WEBHOOK_SECRET;
  beforeEach(() => {
    process.env.PADDLE_WEBHOOK_SECRET = SECRET;
  });
  afterEach(() => {
    if (OLD === undefined) delete process.env.PADDLE_WEBHOOK_SECRET;
    else process.env.PADDLE_WEBHOOK_SECRET = OLD;
  });

  it('verifies, then hands the event type and payload to the service', async () => {
    const handleEvent = jest.fn().mockResolvedValue(undefined);
    const service = new PaddleWebhookService({} as never, {} as never);
    service.handleEvent = handleEvent;
    const controller = controllerWith(service);

    const raw = Buffer.from(
      JSON.stringify({
        event_type: 'subscription.updated',
        data: { id: 'sub_1' },
      }),
    );

    await expect(
      controller.handlePaddleWebhook(
        { rawBody: raw } as never,
        signedHeader(raw),
      ),
    ).resolves.toEqual({ received: true });

    // `event_type` is TOP LEVEL on Paddle's envelope, not nested under `meta`
    // as Lemon Squeezy's `event_name` is.
    expect(handleEvent).toHaveBeenCalledWith(
      'subscription.updated',
      expect.objectContaining({ event_type: 'subscription.updated' }),
    );
  });

  it('rejects a forged signature with a 400 and never calls the handler', async () => {
    // A 400 so Paddle does not retry a body it cannot fix; a 500 would be a
    // retry storm against a request that will always fail.
    const handleEvent = jest.fn();
    const controller = controllerWith({
      verifySignature: () => false,
      handleEvent,
    } as never);

    await expect(
      controller.handlePaddleWebhook(
        { rawBody: Buffer.from('{}') } as never,
        'ts=1;h1=deadbeef',
      ),
    ).rejects.toThrow(BadRequestException);

    expect(handleEvent).not.toHaveBeenCalled();
  });

  it('passes the RAW bytes to verification, not a re-serialised body', async () => {
    // Paddle signs the exact bytes. This body has key order and whitespace
    // that `JSON.stringify` would not reproduce, so a route that re-serialised
    // before verifying would fail it.
    const raw = Buffer.from('{ "event_type":"subscription.updated",  "z":1 }');
    const seen: Buffer[] = [];
    const controller = controllerWith({
      verifySignature: (b: Buffer) => {
        seen.push(b);
        return true;
      },
      handleEvent: jest.fn().mockResolvedValue(undefined),
    } as never);

    await controller.handlePaddleWebhook({ rawBody: raw } as never, 'ts=1;h1=x');

    expect(seen).toHaveLength(1);
    expect(seen[0].equals(raw)).toBe(true);
  });

  it('refuses a delivery whose signature header is absent', async () => {
    // Calling the method directly BYPASSES `@Headers`, so this does not and
    // cannot pin which header name the route binds — mutating
    // `paddle-signature` to `x-signature` leaves every test here passing.
    // The binding is pinned by the source assertion at the bottom of this
    // file instead; what this one proves is that a missing header is refused
    // rather than treated as an empty, passing signature.
    const service = new PaddleWebhookService({} as never, {} as never);
    service.handleEvent = jest.fn().mockResolvedValue(undefined);
    const controller = controllerWith(service);

    const raw = Buffer.from(JSON.stringify({ event_type: 'x', data: {} }));

    await expect(
      controller.handlePaddleWebhook(
        { rawBody: raw } as never,
        signedHeader(raw),
      ),
    ).resolves.toEqual({ received: true });

    await expect(
      controller.handlePaddleWebhook({ rawBody: raw } as never, undefined as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('400s a body that verified but is not JSON', async () => {
    // Rather than an uncaught SyntaxError, which would be a 500 and a retry.
    const handleEvent = jest.fn();
    const controller = controllerWith({
      verifySignature: () => true,
      handleEvent,
    } as never);

    await expect(
      controller.handlePaddleWebhook(
        { rawBody: Buffer.from('not json') } as never,
        'ts=1;h1=x',
      ),
    ).rejects.toThrow(BadRequestException);

    expect(handleEvent).not.toHaveBeenCalled();
  });

  it('400s when there is no raw body at all', async () => {
    const controller = controllerWith({
      verifySignature: () => true,
      handleEvent: jest.fn(),
    } as never);

    await expect(
      controller.handlePaddleWebhook({} as never, 'ts=1;h1=x'),
    ).rejects.toThrow(BadRequestException);
  });

  it('lets a handler failure propagate, so the delivery is retried', async () => {
    // The opposite of a forged body: a genuine event we failed to apply MUST
    // be retried, so this one is not swallowed into a 200.
    const controller = controllerWith({
      verifySignature: () => true,
      handleEvent: jest.fn().mockRejectedValue(new Error('db down')),
    } as never);

    await expect(
      controller.handlePaddleWebhook(
        { rawBody: Buffer.from('{"event_type":"x"}') } as never,
        'ts=1;h1=x',
      ),
    ).rejects.toThrow('db down');
  });

  it('answers an event type it does not know, rather than 400ing', async () => {
    // Paddle sends events we never subscribed to and retries anything that is
    // not 2xx. Refusing one would be an infinite retry of a harmless event.
    const service = new PaddleWebhookService({} as never, {} as never);
    const controller = controllerWith(service);

    const raw = Buffer.from(
      JSON.stringify({ event_type: 'customer.created', data: { id: 'ctm_1' } }),
    );

    await expect(
      controller.handlePaddleWebhook(
        { rawBody: raw } as never,
        signedHeader(raw),
      ),
    ).resolves.toEqual({ received: true });
  });
});

/**
 * The route's DECORATORS, read from source.
 *
 * Calling a controller method directly never runs `@Headers`, `@Post` or
 * `@HttpCode`, so nothing above can tell `paddle-signature` from
 * `x-signature` — and reading Lemon Squeezy's header here would refuse every
 * genuine Paddle delivery while looking exactly like a wrong secret. A
 * source check is the cheapest thing that catches it; the alternative is
 * booting the whole twelve-service controller over HTTP for one string.
 */
describe('the route bindings', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'billing.controller.ts'),
    'utf8',
  ) as string;

  const route = src.slice(
    src.indexOf("@Post('webhooks/paddle')"),
    src.indexOf('return { received: true };', src.indexOf("@Post('webhooks/paddle')")),
  );

  it('finds the route (the reader is not silently empty)', () => {
    expect(route.length).toBeGreaterThan(200);
  });

  it('binds Paddle’s own signature header', () => {
    expect(route).toContain("@Headers('paddle-signature')");
    expect(route).not.toContain("@Headers('x-signature')");
  });

  it('answers 200, so Paddle does not retry a delivery we accepted', () => {
    expect(route).toContain('@HttpCode(HttpStatus.OK)');
  });
});
