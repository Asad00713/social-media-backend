/* eslint-disable @typescript-eslint/require-await -- db double */
import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { leadForms, leads } from '../../drizzle/schema/ads.schema';

let updates: Record<string, unknown>[];

const LEAD = {
  id: 'lead-1',
  leadFormId: 'form-1',
  capturedAt: new Date('2026-11-12T10:42:00Z'),
  fieldData: [
    { name: 'Full name', values: ['Sana Malik'] },
    { name: 'Email', values: ['sana@lumierecafe.pk'] },
  ] as { name: string; values: string[] }[],
  deliveryAttempts: [] as unknown[],
};

let form: { name: string } | null;

const mockDb = {
  select: jest.fn(() => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: async () =>
          table === leads ? [LEAD] : table === leadForms && form ? [form] : [],
      }),
    }),
  })),
  update: jest.fn(() => ({
    set: (set: Record<string, unknown>) => {
      updates.push(set);
      return { where: async () => undefined };
    },
  })),
};

jest.mock('../../drizzle/db', () => ({ db: mockDb }));

// Count real requests: undici's fetch is what fetchPublic sends through.
jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { ...actual, fetch: jest.fn() };
});
import { fetch as undiciFetch } from 'undici';
const mockedFetch = undiciFetch as unknown as jest.Mock;
import { publicAgent } from '../../common/net/public-fetch';

import type { DeliverOptions, EmailService } from '../../email/email.service';
import { AppLinks } from '../../email/links/app-links';
import type { EmailSuppressionRepository } from '../../email/suppression/email-suppression.repository';
import { LeadRouterService } from './lead-router.service';

type Msg = { to: string; subject: string; html: string; text?: string };

function setup(suppressed = false) {
  const isSuppressed = jest.fn(() => Promise.resolve(suppressed));
  const deliver = jest.fn<
    Promise<{ success: boolean; error?: string }>,
    [Msg, DeliverOptions]
  >(() => Promise.resolve({ success: true }));
  const config = { get: jest.fn(() => undefined) } as unknown as ConfigService;
  const service = new LeadRouterService(
    { deliver } as unknown as EmailService,
    new AppLinks(config),
    { isSuppressed } as unknown as EmailSuppressionRepository,
  );
  return { service, deliver, isSuppressed };
}

const ROUTE = { to: 'owner@lumierecafe.pk' };

beforeEach(() => {
  updates = [];
  form = { name: 'Spring menu waitlist' };
  LEAD.deliveryAttempts = [];
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  // No real request may leave a test: the global fetch is stubbed as well.
  jest
    .spyOn(global, 'fetch')
    .mockRejectedValue(new Error('global fetch is stubbed in this spec'));
});
afterEach(() => jest.restoreAllMocks());

describe('LeadRouterService email route', () => {
  it('skips a suppressed recipient: no send, a failed attempt recorded, logged, no retry', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { service, deliver, isSuppressed } = setup(true);

    await expect(
      service.deliver('lead-1', 'route-1', 'email', ROUTE),
    ).resolves.toBeUndefined();

    expect(isSuppressed).toHaveBeenCalledWith('owner@lumierecafe.pk');
    expect(deliver).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ deliveryStatus: 'failed' });
    const lines = warn.mock.calls.map((c) => String(c[0])).join(' ');
    expect(lines).toContain('suppressed');
    expect(lines).not.toContain('owner@lumierecafe.pk');
  });

  it('sends the lead-delivered email through deliver, tagged for leads', async () => {
    const { service, deliver } = setup();
    await service.deliver('lead-1', 'route-1', 'email', ROUTE);

    expect(deliver).toHaveBeenCalledTimes(1);
    const [msg, opts] = deliver.mock.calls[0];
    expect(msg.to).toBe('owner@lumierecafe.pk');
    expect(msg.subject).toBe('New lead captured: Spring menu waitlist');
    expect(opts).toEqual({
      idempotencyKey: 'lead.lead-1.route-1',
      tags: { category: 'leads', template: 'lead-delivered' },
    });
    expect(updates.at(-1)).toMatchObject({ deliveryStatus: 'delivered' });
  });

  it('uses the shared layout: the fields, the capture time and the footer', async () => {
    const { service, deliver } = setup();
    await service.deliver('lead-1', 'route-1', 'email', ROUTE);
    const [{ html, text }] = deliver.mock.calls[0];
    for (const part of [
      'Full name',
      'Sana Malik',
      'sana@lumierecafe.pk',
      'Nov 12, 2026 at 10:42 AM UTC',
      'lead-1',
      'Schedura · schedura.ai',
      'Help center',
    ]) {
      expect(html).toContain(part);
    }
    expect(text).toContain('Sana Malik');
  });

  it('escapes what the lead typed', async () => {
    LEAD.fieldData = [
      { name: 'Na<me>', values: ['<script>alert(1)</script> & "co"'] },
    ];
    const { service, deliver } = setup();
    await service.deliver('lead-1', 'route-1', 'email', ROUTE);
    const [{ html }] = deliver.mock.calls[0];
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp;');
    expect(html).toContain('Na&lt;me&gt;');
  });

  it('sends the same idempotency key on a retry after a failure', async () => {
    const { service, deliver } = setup();
    deliver.mockResolvedValueOnce({ success: false, error: 'Resend down' });

    await expect(
      service.deliver('lead-1', 'route-1', 'email', ROUTE),
    ).rejects.toThrow('Resend down');
    await service.deliver('lead-1', 'route-1', 'email', ROUTE);

    const keys = deliver.mock.calls.map(([, opts]) => opts.idempotencyKey);
    expect(keys).toEqual(['lead.lead-1.route-1', 'lead.lead-1.route-1']);
    expect(keys[0]).toMatch(/^[A-Za-z0-9._-]{1,200}$/);
  });

  it('records the failed attempt and rethrows, so BullMQ retries', async () => {
    const { service, deliver } = setup();
    deliver.mockResolvedValue({ success: false, error: 'Resend down' });
    await expect(
      service.deliver('lead-1', 'route-1', 'email', ROUTE),
    ).rejects.toThrow('Resend down');
    expect(updates.at(-1)).toMatchObject({ deliveryStatus: 'failed' });
  });

  it('gives a different key to a different route of the same lead', async () => {
    const { service, deliver } = setup();
    await service.deliver('lead-1', 'route-1', 'email', ROUTE);
    await service.deliver('lead-1', 'route-2', 'email', ROUTE);
    expect(deliver.mock.calls.map(([, o]) => o.idempotencyKey)).toEqual([
      'lead.lead-1.route-1',
      'lead.lead-1.route-2',
    ]);
  });

  it('fails without a to address, and sends nothing', async () => {
    const { service, deliver } = setup();
    await expect(
      service.deliver('lead-1', 'route-1', 'email', {}),
    ).rejects.toThrow('Email route config missing "to" address');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('names an unknown form, and a lead with no fields', async () => {
    form = null;
    LEAD.fieldData = [];
    const { service, deliver } = setup();
    await service.deliver('lead-1', 'route-1', 'email', ROUTE);
    const [{ subject, html }] = deliver.mock.calls[0];
    expect(subject).toBe('New lead captured: Unknown Form');
    expect(html).toContain('This lead has no fields.');
  });
});

describe('LeadRouterService webhook route', () => {
  const PUBLIC_URL = 'https://93.184.216.34/hook';
  beforeEach(() => mockedFetch.mockReset());

  it.each([
    'http://127.0.0.1/hook',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.8/hook',
    'http://[::1]/hook',
  ])(
    'refuses a stored %s: nothing sent, a failed attempt, no retry',
    async (url) => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const { service } = setup();
      await expect(
        service.deliver('lead-1', 'route-1', 'webhook', { url }),
      ).resolves.toBeUndefined();
      expect(mockedFetch).not.toHaveBeenCalled();
      expect(updates.at(-1)).toMatchObject({ deliveryStatus: 'failed' });
      const attempts = updates.at(-1)?.deliveryAttempts as {
        error?: string;
      }[];
      expect(attempts.at(-1)?.error).toBe(
        "That webhook URL isn't reachable from the internet.",
      );
      expect(warn).toHaveBeenCalled();
    },
  );

  it('refuses localhost by name at connect time: the server is never reached, no retry', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    mockedFetch.mockImplementation(
      jest.requireActual<typeof import('undici')>('undici').fetch,
    );
    try {
      const { service } = setup();
      await expect(
        service.deliver('lead-1', 'route-1', 'webhook', {
          url: `http://localhost:${port}/hook`,
        }),
      ).resolves.toBeUndefined();
      expect(hits).toEqual([]);
      expect(updates.at(-1)).toMatchObject({ deliveryStatus: 'failed' });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('POSTs a public URL through the pinned agent, redirects manual', async () => {
    mockedFetch.mockResolvedValue(new Response('ok'));
    const { service } = setup();
    await service.deliver('lead-1', 'route-1', 'webhook', {
      url: PUBLIC_URL,
      secret: 's3cret',
    });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedFetch.mock.calls[0] as [
      string,
      { method: string; redirect: string; dispatcher: unknown },
    ];
    expect(url).toBe(PUBLIC_URL);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.dispatcher).toBe(publicAgent);
    expect(updates.at(-1)).toMatchObject({ deliveryStatus: 'delivered' });
  });

  it('treats a 3xx as a failed delivery and does not follow it', async () => {
    mockedFetch.mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { location: 'http://169.254.169.254/' },
      }),
    );
    const { service } = setup();
    await expect(
      service.deliver('lead-1', 'route-1', 'webhook', { url: PUBLIC_URL }),
    ).rejects.toThrow(/HTTP 307/);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(updates.at(-1)).toMatchObject({ deliveryStatus: 'failed' });
  });
});
