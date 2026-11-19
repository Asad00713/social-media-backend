import { Logger } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  BillingOverviewService,
  MAX_INVOICE_LIMIT,
  PROVIDER_TIMEOUT_MS,
  ProviderTimeoutError,
  clampLimit,
  withProviderTimeout,
} from './billing-overview.service';
import { PAYMENT_GRACE_DAYS } from './webhook.service';
import {
  aiUsageLog,
  billingPaymentAlerts,
  workspace,
} from '../../drizzle/schema';
import type { BillingDashboard } from './dashboard.service';
import type {
  BillingProfile,
  ProviderInvoice,
} from '../providers/payment-provider.interface';

const NOW = new Date('2026-11-17T12:00:00.000Z');
const PERIOD_END = new Date('2026-12-01T00:00:00.000Z');
const OWNER = 'owner-1';
const WS = 'ws-1';

function sub(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    userId: OWNER,
    planCode: 'PRO',
    status: 'active',
    currentPeriodEnd: PERIOD_END,
    cancelAtPeriodEnd: false,
    updatedAt: new Date('2026-11-10T00:00:00.000Z'),
    ...over,
  };
}

function dashboard(over: Partial<BillingDashboard> = {}): BillingDashboard {
  return {
    subscription: {
      id: 7,
      planCode: 'PRO',
      planName: 'Pro',
      status: 'active',
      currentPeriodStart: null,
      currentPeriodEnd: PERIOD_END,
      cancelAtPeriodEnd: false,
      trialEnd: null,
    },
    usage: {
      channelsCount: 4,
      channelsLimit: 10,
      channelsPercentage: 40,
      membersCount: 2,
      membersLimit: 5,
      membersPercentage: 40,
      extraChannelsPurchased: 0,
      extraMembersPurchased: 0,
      aiTokensUsed: 300,
      aiTokensLimit: 2000,
      aiTokensPercentage: 15,
      extraAiTokensPurchased: 0,
    },
    billing: {
      // base 2900 + 2 extra seats at 600
      monthlyTotal: 4100,
      monthlyTotalFormatted: '$41.00/month',
      basePlanCost: 2900,
      addonsCost: 1200,
      nextBillingDate: PERIOD_END,
    },
    recentInvoices: [],
    recentChanges: [],
    ...over,
  };
}

const INVOICE = (over: Partial<ProviderInvoice> = {}): ProviderInvoice => ({
  id: 'inv-1',
  date: '2026-11-01T00:00:00.000Z',
  description: 'Pro plan',
  amountCents: 2900,
  currency: 'USD',
  status: 'paid',
  downloadUrl: 'https://ls.test/inv-1.pdf',
  ...over,
});

const PROFILE: BillingProfile = {
  card: { brand: 'visa', last4: '4242' },
  billingDetails: { name: 'Ada', email: 'ada@x.test', country: 'GB' },
};

/**
 * A db whose `select().from(table)...` chain resolves to the rows seeded for
 * that table, whatever clauses follow.
 */
function fakeDb(rowsByTable: Map<unknown, unknown[]>) {
  /** Every clause handed to `.where()`, per table read. */
  const wheres = new Map<unknown, unknown[]>();
  const joins: unknown[] = [];
  const chain = (table: unknown, rows: unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ['orderBy', 'limit', 'groupBy']) {
      c[m] = jest.fn(() => c);
    }
    c.innerJoin = jest.fn((t: unknown) => {
      joins.push(t);
      return c;
    });
    c.where = jest.fn((cond: unknown) => {
      wheres.set(table, [...(wheres.get(table) ?? []), cond]);
      return c;
    });
    c.then = (resolve: (v: unknown[]) => unknown) => resolve(rows);
    return c;
  };
  return {
    wheres,
    joins,
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) =>
        chain(table, rowsByTable.get(table) ?? []),
      ),
    })),
  };
}

function build(
  opts: {
    sub?: ReturnType<typeof sub> | null;
    dash?: BillingDashboard;
    alerts?: Array<{ kind: string; createdAt: Date }>;
    aiRows?: Array<{ feature: string; used: string }>;
    adapter?: Record<string, jest.Mock>;
    /** The workspace is soft-deleted (isWorkspaceLive finds no live row). */
    deleted?: boolean;
  } = {},
) {
  const adapter = {
    name: 'lemonsqueezy',
    getBillingProfile: jest.fn().mockResolvedValue(PROFILE),
    listInvoices: jest.fn().mockResolvedValue([INVOICE()]),
    createPortalLink: jest.fn().mockResolvedValue({ url: 'https://ls.test/p' }),
    ...opts.adapter,
  };
  const lookup = {
    findByWorkspaceId: jest
      .fn()
      .mockResolvedValue('sub' in opts ? opts.sub : sub()),
    getOwnerId: jest.fn().mockResolvedValue(OWNER),
  };
  const dash = {
    getWorkspaceDashboard: jest
      .fn()
      .mockResolvedValue(opts.dash ?? dashboard()),
  };
  const registry = {
    adapterForSubscription: jest.fn().mockResolvedValue(adapter),
    providerForUser: jest.fn().mockResolvedValue('lemonsqueezy'),
  };
  const db = fakeDb(
    new Map<unknown, unknown[]>([
      [billingPaymentAlerts, opts.alerts ?? []],
      [aiUsageLog, opts.aiRows ?? []],
      [workspace, opts.deleted ? [] : [{ id: WS }]],
    ]),
  );
  const service = new BillingOverviewService(
    db as never,
    lookup as never,
    dash as never,
    registry as never,
  );
  return { service, adapter, lookup, dash, registry, db };
}

describe('BillingOverviewService', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('overview', () => {
    it('is free with no card, next invoice or failure when there is no subscription', async () => {
      const { service, adapter, registry } = build({
        sub: null,
        dash: dashboard({ subscription: null }),
      });

      const out = await service.overview(WS);

      expect(out).toMatchObject({
        provider: 'lemonsqueezy',
        plan: { code: 'FREE', name: 'Free', priceCents: 0, interval: 'month' },
        status: 'free',
        renewsAt: null,
        endsAt: null,
        card: null,
        billingDetails: null,
        profileUnavailable: false,
        nextInvoice: null,
        paymentFailure: null,
      });
      expect(adapter.getBillingProfile).not.toHaveBeenCalled();
      expect(registry.adapterForSubscription).not.toHaveBeenCalled();
    });

    it('treats a FREE subscription row like no subscription', async () => {
      const { service, adapter } = build({
        sub: sub({ planCode: 'FREE' }),
        dash: dashboard({
          subscription: {
            ...dashboard().subscription!,
            planCode: 'FREE',
            planName: 'Free',
          },
        }),
      });

      const out = await service.overview(WS);

      expect(out.status).toBe('free');
      expect(out.plan.name).toBe('Free');
      expect(out.nextInvoice).toBeNull();
      expect(adapter.getBillingProfile).not.toHaveBeenCalled();
    });

    it('maps an active Lemon Squeezy account: card, details, base plus add-ons', async () => {
      const { service } = build();

      const out = await service.overview(WS);

      expect(out.provider).toBe('lemonsqueezy');
      expect(out.status).toBe('active');
      expect(out.plan).toEqual({
        code: 'PRO',
        name: 'Pro',
        priceCents: 2900,
        interval: 'month',
      });
      expect(out.card).toEqual({ brand: 'visa', last4: '4242' });
      expect(out.billingDetails).toEqual(PROFILE.billingDetails);
      expect(out.renewsAt).toBe(PERIOD_END.toISOString());
      expect(out.endsAt).toBeNull();
      expect(out.nextInvoice).toEqual({
        amountCents: 4100,
        currency: 'USD',
        date: PERIOD_END.toISOString(),
      });
      expect(out.paymentFailure).toBeNull();
      expect(out.usage).toMatchObject({
        channels: { used: 4, limit: 10 },
        members: { used: 2, limit: 5 },
        aiCredits: { used: 300, limit: 2000, byFeature: null },
      });
    });

    it('reports a trialing account as trialing', async () => {
      const { service } = build({ sub: sub({ status: 'trialing' }) });
      expect((await service.overview(WS)).status).toBe('trialing');
    });

    it('resets AI credits on the first of next month', async () => {
      const { service } = build();
      const out = await service.overview(WS);
      expect(out.usage.aiCredits.resetsAt).toBe(
        new Date(NOW.getFullYear(), NOW.getMonth() + 1, 1).toISOString(),
      );
    });

    it('a cancelling account ends at the period end instead of renewing', async () => {
      const { service } = build({ sub: sub({ cancelAtPeriodEnd: true }) });

      const out = await service.overview(WS);

      expect(out.status).toBe('cancelled_at_period_end');
      expect(out.endsAt).toBe(PERIOD_END.toISOString());
      expect(out.renewsAt).toBeNull();
      expect(out.nextInvoice).toBeNull();
    });

    it('still resolves, with no card, when the provider profile throws', async () => {
      const { service } = build({
        adapter: {
          getBillingProfile: jest.fn().mockRejectedValue(new Error('LS 500')),
        },
      });

      const out = await service.overview(WS);

      expect(out.card).toBeNull();
      expect(out.billingDetails).toBeNull();
      expect(out.profileUnavailable).toBe(true);
      expect(out.status).toBe('active');
      expect(out.usage.channels.limit).toBe(10);
    });

    it('still resolves when the provider profile hangs past the timeout', async () => {
      const { service } = build({
        adapter: {
          getBillingProfile: jest.fn(() => new Promise(() => undefined)),
        },
      });

      const pending = service.overview(WS);
      await jest.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS);
      const out = await pending;

      expect(out.card).toBeNull();
      expect(out.profileUnavailable).toBe(true);
    });

    it('serves the profile from cache within 10 minutes, refetches when the subscription changed', async () => {
      const { service, adapter, lookup } = build();

      await service.overview(WS);
      await service.overview(WS);
      expect(adapter.getBillingProfile).toHaveBeenCalledTimes(1);

      lookup.findByWorkspaceId.mockResolvedValue(
        sub({ updatedAt: new Date('2026-11-17T11:59:00.000Z') }),
      );
      await service.overview(WS);
      expect(adapter.getBillingProfile).toHaveBeenCalledTimes(2);
    });

    it('does not cache a failed profile', async () => {
      const getBillingProfile = jest
        .fn()
        .mockRejectedValueOnce(new Error('LS 500'))
        .mockResolvedValue(PROFILE);
      const { service } = build({ adapter: { getBillingProfile } });

      expect((await service.overview(WS)).card).toBeNull();
      expect((await service.overview(WS)).card).toEqual(PROFILE.card);
    });

    describe('paymentFailure', () => {
      const day = (d: number) => new Date(Date.UTC(2026, 10, d));

      it('graceUntil is the first unresolved failure after the latest recovery, plus the grace window', async () => {
        // failed Nov 1 -> recovered Nov 3 -> failed Nov 10 (newest first)
        const { service } = build({
          sub: sub({ status: 'past_due' }),
          alerts: [
            { kind: 'failed', createdAt: day(10) },
            { kind: 'recovered', createdAt: day(3) },
            { kind: 'failed', createdAt: day(1) },
          ],
          adapter: {
            listInvoices: jest
              .fn()
              .mockResolvedValue([
                INVOICE({ id: 'a', status: 'failed', amountCents: 3500 }),
                INVOICE({ id: 'b', status: 'paid', amountCents: 2900 }),
              ]),
          },
        });

        const out = await service.overview(WS);

        expect(PAYMENT_GRACE_DAYS).toBe(7);
        expect(out.status).toBe('past_due');
        expect(out.paymentFailure).toEqual({
          amountCents: 3500,
          currency: 'USD',
          graceUntil: day(17).toISOString(),
        });
      });

      it('counts from the oldest failure of the current run when several failed in a row', async () => {
        const { service } = build({
          sub: sub({ status: 'past_due' }),
          alerts: [
            { kind: 'failed', createdAt: day(12) },
            { kind: 'failed', createdAt: day(10) },
            { kind: 'recovered', createdAt: day(3) },
          ],
        });
        const out = await service.overview(WS);
        expect(out.paymentFailure?.graceUntil).toBe(day(17).toISOString());
      });

      it('falls back to the next invoice amount when no failed invoice is listed', async () => {
        const { service } = build({
          sub: sub({ status: 'past_due' }),
          alerts: [{ kind: 'failed', createdAt: day(10) }],
        });
        const out = await service.overview(WS);
        expect(out.paymentFailure?.amountCents).toBe(4100);
      });

      it('falls back to the next invoice amount when the provider invoice list is down', async () => {
        const { service } = build({
          sub: sub({ status: 'past_due' }),
          alerts: [{ kind: 'failed', createdAt: day(10) }],
          adapter: {
            listInvoices: jest.fn().mockRejectedValue(new Error('LS down')),
          },
        });
        const out = await service.overview(WS);
        expect(out.paymentFailure).toMatchObject({ amountCents: 4100 });
        expect(out.status).toBe('past_due');
      });

      it('uses the subscription updated_at when no alert is on record', async () => {
        const updatedAt = day(12);
        const { service } = build({
          sub: sub({ status: 'past_due', updatedAt }),
        });
        const out = await service.overview(WS);
        expect(out.paymentFailure?.graceUntil).toBe(day(19).toISOString());
      });

      it('is null for an account that is not past due', async () => {
        const { service } = build({
          alerts: [{ kind: 'failed', createdAt: day(10) }],
        });
        expect((await service.overview(WS)).paymentFailure).toBeNull();
      });
    });

    describe('usage by feature', () => {
      /** The SQL text and bound params of the ai_usage_log read's WHERE. */
      function aiWhere(db: ReturnType<typeof fakeDb>) {
        const [cond] = db.wheres.get(aiUsageLog) ?? [];
        return new PgDialect().sqlToQuery(cond as SQL);
      }

      it('is scoped to the route workspace, the same scope as the meter', async () => {
        const { service, db } = build({
          aiRows: [{ feature: 'generate_post', used: '260' }],
        });

        await service.overview(WS);

        const { sql: text, params } = aiWhere(db);
        expect(text).toContain('"ai_usage_log"."workspace_id" = $');
        expect(params).toContain(WS);
        // Not the owner's other workspaces: no join through workspace.owner_id.
        expect(params).not.toContain(OWNER);
        expect(db.joins).toHaveLength(0);
      });

      it('asks for a different workspace when the route names one', async () => {
        const { service, db } = build();
        await service.overview('ws-other');
        expect(aiWhere(db).params).toContain('ws-other');
      });

      it("lists this month's credits per operation, biggest first", async () => {
        const { service } = build({
          aiRows: [
            { feature: 'generate_caption', used: '40' },
            { feature: 'generate_post', used: '260' },
          ],
        });
        const out = await service.overview(WS);
        expect(out.usage.aiCredits.byFeature).toEqual([
          { feature: 'generate_post', used: 260 },
          { feature: 'generate_caption', used: 40 },
        ]);
      });

      it('is null when nothing was logged', async () => {
        const { service } = build({ aiRows: [] });
        expect(
          (await service.overview(WS)).usage.aiCredits.byFeature,
        ).toBeNull();
      });
    });
  });

  describe('invoices', () => {
    it('returns the provider rows', async () => {
      const { service, adapter } = build();

      const out = await service.invoices(WS);

      expect(out).toEqual({
        invoices: [INVOICE()],
        invoicesUnavailable: false,
      });
      expect(adapter.listInvoices).toHaveBeenCalledWith(7, 24);
    });

    it('a second call within 10 minutes does not call the adapter again', async () => {
      const { service, adapter } = build();

      await service.invoices(WS);
      await jest.advanceTimersByTimeAsync(9 * 60 * 1000);
      await service.invoices(WS);

      expect(adapter.listInvoices).toHaveBeenCalledTimes(1);
    });

    it('refetches after the 10 minutes are up', async () => {
      const { service, adapter } = build();

      await service.invoices(WS);
      await jest.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
      await service.invoices(WS);

      expect(adapter.listInvoices).toHaveBeenCalledTimes(2);
    });

    it('a changed subscription updated_at refetches', async () => {
      const { service, adapter, lookup } = build();

      await service.invoices(WS);
      lookup.findByWorkspaceId.mockResolvedValue(
        sub({ updatedAt: new Date('2026-11-17T11:00:00.000Z') }),
      );
      await service.invoices(WS);

      expect(adapter.listInvoices).toHaveBeenCalledTimes(2);
    });

    it('answers an empty page, not an error, when the provider throws', async () => {
      const { service } = build({
        adapter: {
          listInvoices: jest.fn().mockRejectedValue(new Error('LS 500')),
        },
      });

      await expect(service.invoices(WS)).resolves.toEqual({
        invoices: [],
        invoicesUnavailable: true,
      });
    });

    it('gives up on a provider that never answers', async () => {
      const { service } = build({
        adapter: { listInvoices: jest.fn(() => new Promise(() => undefined)) },
      });

      const pending = service.invoices(WS);
      await jest.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS);

      await expect(pending).resolves.toEqual({
        invoices: [],
        invoicesUnavailable: true,
      });
    });

    it('does not cache a failure', async () => {
      const listInvoices = jest
        .fn()
        .mockRejectedValueOnce(new Error('LS 500'))
        .mockResolvedValue([INVOICE()]);
      const { service } = build({ adapter: { listInvoices } });

      expect((await service.invoices(WS)).invoicesUnavailable).toBe(true);
      expect((await service.invoices(WS)).invoices).toHaveLength(1);
    });

    it('clamps the limit to 100, the most Lemon Squeezy accepts', async () => {
      const { service, adapter } = build();

      await service.invoices(WS, 5000);

      expect(adapter.listInvoices).toHaveBeenCalledWith(7, MAX_INVOICE_LIMIT);
    });

    it('is empty, without a provider call, for a free account', async () => {
      const { service, adapter } = build({ sub: null });
      await expect(service.invoices(WS)).resolves.toEqual({
        invoices: [],
        invoicesUnavailable: false,
      });
      expect(adapter.listInvoices).not.toHaveBeenCalled();
    });
  });

  describe('a soft-deleted workspace', () => {
    it('answers 404 on overview, invoices and portal link, without a provider call', async () => {
      const { service, adapter, lookup } = build({ deleted: true });

      await expect(service.overview(WS)).rejects.toMatchObject({
        status: 404,
      });
      await expect(service.invoices(WS)).rejects.toMatchObject({
        status: 404,
      });
      await expect(service.portalLink(WS, 'portal')).rejects.toMatchObject({
        status: 404,
      });
      expect(lookup.findByWorkspaceId).not.toHaveBeenCalled();
      expect(adapter.getBillingProfile).not.toHaveBeenCalled();
      expect(adapter.listInvoices).not.toHaveBeenCalled();
      expect(adapter.createPortalLink).not.toHaveBeenCalled();
    });
  });

  describe('portalLink', () => {
    it('calls the adapter every time, naming the workspace', async () => {
      const { service, adapter } = build();

      await service.portalLink(WS, 'portal');
      const out = await service.portalLink(WS, 'update_payment_method');

      expect(out).toEqual({ url: 'https://ls.test/p' });
      expect(adapter.createPortalLink).toHaveBeenCalledTimes(2);
      expect(adapter.createPortalLink).toHaveBeenNthCalledWith(1, 7, 'portal', {
        workspaceId: WS,
      });
      expect(adapter.createPortalLink).toHaveBeenNthCalledWith(
        2,
        7,
        'update_payment_method',
        { workspaceId: WS },
      );
    });

    it('lets a provider error through unchanged', async () => {
      const boom = new Error('LS 500');
      const { service } = build({
        adapter: { createPortalLink: jest.fn().mockRejectedValue(boom) },
      });
      await expect(service.portalLink(WS, 'portal')).rejects.toBe(boom);
    });

    it('answers 502 PORTAL_UNAVAILABLE when the provider hangs', async () => {
      const { service } = build({
        adapter: {
          createPortalLink: jest.fn(() => new Promise(() => undefined)),
        },
      });

      const pending = service.portalLink(WS, 'portal');
      const caught = pending.catch((e: unknown) => e);
      await jest.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS);
      const err = (await caught) as {
        getStatus(): number;
        getResponse(): unknown;
      };

      expect(err.getStatus()).toBe(502);
      expect(err.getResponse()).toMatchObject({ code: 'PORTAL_UNAVAILABLE' });
    });

    it('answers 404 NO_SUBSCRIPTION for a free account, without a provider call', async () => {
      const { service, adapter } = build({ sub: null });
      const err = (await service
        .portalLink(WS, 'portal')
        .catch((e: unknown) => e)) as { getResponse(): unknown };
      expect(err.getResponse()).toMatchObject({
        statusCode: 404,
        code: 'NO_SUBSCRIPTION',
      });
      expect(adapter.createPortalLink).not.toHaveBeenCalled();
    });
  });
});

describe('clampLimit', () => {
  it.each([
    [24, 24],
    [100, 100],
    [101, 100],
    [100000, 100],
    [0, 1],
    [-5, 1],
    [7.9, 7],
    [NaN, 24],
  ])('%p -> %p', (input, expected) => {
    expect(clampLimit(input)).toBe(expected);
  });
});

describe('withProviderTimeout', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('passes the result through and clears its timer', async () => {
    await expect(
      withProviderTimeout('x', () => Promise.resolve(3)),
    ).resolves.toBe(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects with ProviderTimeoutError once the time is up', async () => {
    const pending = withProviderTimeout(
      'slow',
      () => new Promise(() => undefined),
      50,
    );
    const caught = pending.catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(50);
    expect(await caught).toBeInstanceOf(ProviderTimeoutError);
  });
});
