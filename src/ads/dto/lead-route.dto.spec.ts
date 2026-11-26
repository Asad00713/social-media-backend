// No real request may leave a test: both fetches are stubbed, though
// validation alone never sends one.
jest.mock('undici', () => ({
  ...jest.requireActual<typeof import('undici')>('undici'),
  fetch: jest.fn(() =>
    Promise.reject(new Error('undici fetch is stubbed in this spec')),
  ),
}));
beforeEach(() => {
  jest
    .spyOn(global, 'fetch')
    .mockRejectedValue(new Error('global fetch is stubbed in this spec'));
});
afterEach(() => jest.restoreAllMocks());

import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  assertRouteConfig,
  CreateLeadRouteDto,
  TestWebhookDto,
  UpdateLeadRouteDto,
} from './lead-route.dto';

// The same options as the global pipe in main.ts.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

function run(metatype: new () => object, body: unknown): Promise<unknown> {
  return pipe.transform(body, { type: 'body', metatype });
}

async function refused(p: Promise<unknown>): Promise<string[]> {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BadRequestException);
  const res = (err as BadRequestException).getResponse() as {
    message: string[] | string;
  };
  return ([] as string[]).concat(res.message);
}

const LONG_URL = `https://hooks.example.com/${'a'.repeat(2049 - 26)}`;

describe('CreateLeadRouteDto', () => {
  // Exactly what the lead wizard sends (use-create-lead-campaign.ts).
  it.each([
    ['inbox', { type: 'inbox', config: {}, enabled: true }],
    [
      'email',
      { type: 'email', config: { email: 'owner@acme.com' }, enabled: true },
    ],
    [
      'webhook with a secret',
      {
        type: 'webhook',
        config: { url: 'https://hooks.acme.com/lead', secret: 's3cret' },
        enabled: true,
      },
    ],
    [
      'webhook with the empty secret the wizard sends when none is typed',
      {
        type: 'webhook',
        config: { url: 'https://hooks.acme.com/lead', secret: '' },
        enabled: true,
      },
    ],
    [
      'webhook with no secret and no enabled',
      { type: 'webhook', config: { url: 'http://hooks.acme.com/lead' } },
    ],
  ])('accepts the wizard shape: %s', async (_what, body) => {
    const out = (await run(CreateLeadRouteDto, body)) as Record<
      string,
      unknown
    >;
    expect(out).toBeInstanceOf(CreateLeadRouteDto);
    expect(JSON.parse(JSON.stringify(out))).toEqual(body);
  });

  it('keeps localhost and private literals for the save-time check (its copy is friendlier)', async () => {
    for (const url of ['http://localhost/hook', 'http://[::1]/hook']) {
      await expect(
        run(CreateLeadRouteDto, { type: 'webhook', config: { url } }),
      ).resolves.toBeInstanceOf(CreateLeadRouteDto);
    }
  });

  it.each([
    ['an unknown type', { type: 'sms', config: {} }],
    ['a missing type', { config: {} }],
    ['a missing config', { type: 'inbox' }],
    ['a config that is a string', { type: 'inbox', config: 'x' }],
    ['a config that is an array', { type: 'inbox', config: [] }],
    ['enabled as a string', { type: 'inbox', config: {}, enabled: 'yes' }],
    ['an unknown top-level key', { type: 'inbox', config: {}, extra: 1 }],
    ['an inbox config with a key', { type: 'inbox', config: { url: 'x' } }],
    ['an email route with no address', { type: 'email', config: {} }],
    [
      'an email route with a bad address',
      { type: 'email', config: { email: 'not-an-email' } },
    ],
    [
      'an email address that is a number',
      { type: 'email', config: { email: 42 } },
    ],
    [
      'an email route with an extra key',
      { type: 'email', config: { email: 'a@acme.com', url: 'https://x.io' } },
    ],
    ['a webhook with no url', { type: 'webhook', config: {} }],
    [
      'a webhook url that is not a URL',
      { type: 'webhook', config: { url: 'not a url' } },
    ],
    [
      'a webhook url with no scheme',
      { type: 'webhook', config: { url: 'hooks.acme.com/lead' } },
    ],
    [
      'a file: webhook url',
      { type: 'webhook', config: { url: 'file:///etc/passwd' } },
    ],
    [
      'an ftp: webhook url',
      { type: 'webhook', config: { url: 'ftp://hooks.acme.com/lead' } },
    ],
    [
      'a webhook url over 2048 characters',
      { type: 'webhook', config: { url: LONG_URL } },
    ],
    [
      'a webhook secret over 256 characters',
      {
        type: 'webhook',
        config: { url: 'https://hooks.acme.com', secret: 'x'.repeat(257) },
      },
    ],
    [
      'a webhook secret that is a number',
      { type: 'webhook', config: { url: 'https://hooks.acme.com', secret: 1 } },
    ],
    [
      'a webhook config with an extra key',
      {
        type: 'webhook',
        config: { url: 'https://hooks.acme.com', headers: { a: 'b' } },
      },
    ],
    [
      'a webhook route given an email config',
      { type: 'webhook', config: { email: 'a@acme.com' } },
    ],
  ])('refuses %s with a 400', async (_what, body) => {
    const messages = await refused(run(CreateLeadRouteDto, body));
    expect(messages.length).toBeGreaterThan(0);
  });

  it('accepts a 2048-character webhook url and a 256-character secret', async () => {
    const url = `https://hooks.example.com/${'a'.repeat(2048 - 26)}`;
    expect(url).toHaveLength(2048);
    await expect(
      run(CreateLeadRouteDto, {
        type: 'webhook',
        config: { url, secret: 'x'.repeat(256) },
      }),
    ).resolves.toBeInstanceOf(CreateLeadRouteDto);
  });
});

describe('UpdateLeadRouteDto', () => {
  it.each([
    [{ enabled: false }],
    [{ config: { url: 'https://hooks.acme.com' } }],
    [{}],
  ])('accepts %j', async (body) => {
    await expect(run(UpdateLeadRouteDto, body)).resolves.toBeInstanceOf(
      UpdateLeadRouteDto,
    );
  });

  it.each([
    [{ enabled: 'no' }],
    [{ config: 'x' }],
    [{ config: [] }],
    [{ type: 'webhook' }],
    [{ extra: true }],
  ])('refuses %j', async (body) => {
    await refused(run(UpdateLeadRouteDto, body));
  });
});

describe('assertRouteConfig (a PATCH config, against the stored type)', () => {
  it.each([
    ['inbox', {}],
    ['email', { email: 'owner@acme.com' }],
    ['webhook', { url: 'https://hooks.acme.com/lead', secret: '' }],
  ] as const)('accepts a %s config', async (type, config) => {
    await expect(assertRouteConfig(type, config)).resolves.toBeUndefined();
  });

  it.each([
    ['inbox', { url: 'https://hooks.acme.com' }],
    ['email', { url: 'https://hooks.acme.com' }],
    ['email', { email: 'nope' }],
    ['webhook', { email: 'owner@acme.com' }],
    ['webhook', { url: 'javascript:alert(1)' }],
    ['webhook', { url: 'https://hooks.acme.com', extra: 1 }],
    ['sms', {}],
  ])('refuses a %s config %j', async (type, config) => {
    await refused(assertRouteConfig(type, config));
  });
});

describe('TestWebhookDto', () => {
  it('accepts what the test button sends', async () => {
    await expect(
      run(TestWebhookDto, { url: 'https://hooks.acme.com', secret: '' }),
    ).resolves.toBeInstanceOf(TestWebhookDto);
  });

  it.each([
    [{}],
    [{ url: 'file:///etc/passwd' }],
    [{ url: 'https://hooks.acme.com', secret: 'x'.repeat(257) }],
    [{ url: 'https://hooks.acme.com', extra: 1 }],
  ])('refuses %j', async (body) => {
    await refused(run(TestWebhookDto, body));
  });
});
