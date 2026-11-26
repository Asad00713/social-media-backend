/* eslint-disable @typescript-eslint/require-await -- db double */
import { BadRequestException } from '@nestjs/common';
import { fetch as undiciFetch } from 'undici';

// The lead form always belongs to the workspace; writes are recorded.
const inserts: Record<string, unknown>[] = [];
const updates: Record<string, unknown>[] = [];
const mockDb = {
  select: jest.fn(() => ({
    from: () => ({
      where: () => ({
        limit: async () => [{ id: 'form-1', workspaceId: 'ws-1' }],
      }),
    }),
  })),
  insert: jest.fn(() => ({
    values: (v: Record<string, unknown>) => {
      inserts.push(v);
      return { returning: async () => [{ id: 'route-1', ...v }] };
    },
  })),
  update: jest.fn(() => ({
    set: (v: Record<string, unknown>) => {
      updates.push(v);
      return {
        where: () => ({ returning: async () => [{ id: 'route-1', ...v }] }),
      };
    },
  })),
};
jest.mock('../drizzle/db', () => ({ db: mockDb }));

// Count real requests: undici's fetch is what fetchPublic sends through.
jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { ...actual, fetch: jest.fn() };
});
const mockedFetch = undiciFetch as unknown as jest.Mock;

import { publicAgent } from '../common/net/public-fetch';
import { LeadAdsController } from './lead-ads.controller';

const COPY = "That webhook URL isn't reachable from the internet.";
const USER = { userId: 'u-1', email: 'u@example.com' };
const PRIVATE_URLS = [
  'http://localhost/hook',
  'http://127.0.0.1/hook',
  'http://169.254.169.254/latest/meta-data/',
  'http://10.0.0.8/hook',
  'http://[::1]/hook',
];
// A public IP literal: passes the guard without a DNS lookup.
const PUBLIC_URL = 'https://93.184.216.34/hook';

async function refusal(p: Promise<unknown>): Promise<BadRequestException> {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BadRequestException);
  return err as BadRequestException;
}

let controller: LeadAdsController;
beforeEach(() => {
  inserts.length = 0;
  updates.length = 0;
  mockedFetch.mockReset();
  controller = new LeadAdsController();
});

describe('LeadAdsController test-webhook', () => {
  it.each(PRIVATE_URLS)(
    'refuses %s with a 400, and sends nothing',
    async (url) => {
      const err = await refusal(
        controller.testWebhook('ws-1', 'form-1', USER, { url }),
      );
      expect(err.message).toBe(COPY);
      expect(mockedFetch).not.toHaveBeenCalled();
    },
  );

  it('POSTs a public URL through the pinned agent, redirects manual', async () => {
    mockedFetch.mockResolvedValue(new Response('ok', { status: 200 }));
    const result = await controller.testWebhook('ws-1', 'form-1', USER, {
      url: PUBLIC_URL,
      secret: 's3cret',
    });
    expect(result).toEqual({ ok: true, status: 200 });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedFetch.mock.calls[0] as [
      string,
      {
        method: string;
        redirect: string;
        dispatcher: unknown;
        headers: Record<string, string>;
      },
    ];
    expect(url).toBe(PUBLIC_URL);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.dispatcher).toBe(publicAgent);
    expect(init.headers['X-Schedura-Signature']).toBeDefined();
  });

  it('reports a 3xx as a failed test and does not follow it', async () => {
    mockedFetch.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/' },
      }),
    );
    const result = await controller.testWebhook('ws-1', 'form-1', USER, {
      url: PUBLIC_URL,
    });
    expect(result).toEqual({ ok: false, status: 302 });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });
});

describe('LeadAdsController saving a webhook route', () => {
  it.each(PRIVATE_URLS)('refuses to store %s', async (url) => {
    const err = await refusal(
      controller.createRoute('ws-1', 'form-1', USER, {
        type: 'webhook',
        config: { url },
      }),
    );
    expect(err.message).toBe(COPY);
    expect(inserts).toEqual([]);
  });

  it('refuses a webhook route with no URL', async () => {
    await refusal(
      controller.createRoute('ws-1', 'form-1', USER, {
        type: 'webhook',
        config: {},
      }),
    );
    expect(inserts).toEqual([]);
  });

  it('stores a public webhook URL', async () => {
    const { route } = await controller.createRoute('ws-1', 'form-1', USER, {
      type: 'webhook',
      config: { url: PUBLIC_URL },
    });
    expect(route).toMatchObject({ type: 'webhook' });
    expect(inserts).toHaveLength(1);
  });

  it('stores an email route untouched', async () => {
    await controller.createRoute('ws-1', 'form-1', USER, {
      type: 'email',
      config: { to: 'owner@example.com' },
    });
    expect(inserts).toHaveLength(1);
  });

  it.each(PRIVATE_URLS)('refuses to update a route to %s', async (url) => {
    const err = await refusal(
      controller.updateRoute('ws-1', 'form-1', 'route-1', USER, {
        config: { url },
      }),
    );
    expect(err.message).toBe(COPY);
    expect(updates).toEqual([]);
  });

  it('updates a route to a public URL, and a toggle with no config', async () => {
    await controller.updateRoute('ws-1', 'form-1', 'route-1', USER, {
      config: { url: PUBLIC_URL },
    });
    await controller.updateRoute('ws-1', 'form-1', 'route-1', USER, {
      enabled: false,
    });
    expect(updates).toHaveLength(2);
  });
});
