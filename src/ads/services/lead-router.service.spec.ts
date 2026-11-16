/* eslint-disable @typescript-eslint/require-await -- db double */
import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
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
