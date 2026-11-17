// src/billing/providers/lemonsqueezy.adapter.spec.ts
import { Logger } from '@nestjs/common';
import { LemonSqueezyAdapter } from './lemonsqueezy.adapter';
import { LemonSqueezyClient } from './lemonsqueezy.client';
import { subscriptions } from '../../drizzle/schema';

// Every checkout needs a store: POST /v1/checkouts without a store
// relationship answers 422 "The store.id field is required." Jest loads no
// .env, so the adapter's guard would fire on the checkout tests. Set it here
// rather than weakening the guard to suit the test.
const OLD_STORE_ID = process.env.LEMONSQUEEZY_STORE_ID;

beforeEach(() => {
  process.env.LEMONSQUEEZY_STORE_ID = '12345';
});

afterEach(() => {
  if (OLD_STORE_ID === undefined) {
    delete process.env.LEMONSQUEEZY_STORE_ID;
  } else {
    process.env.LEMONSQUEEZY_STORE_ID = OLD_STORE_ID;
  }
});

type Row = {
  id: number;
  itemType: string;
  providerSubscriptionId: string;
  providerItemId: string;
};

function fiveRows(): Row[] {
  return [
    {
      id: 1,
      itemType: 'BASE_PLAN',
      providerSubscriptionId: '100',
      providerItemId: '900',
    },
    {
      id: 2,
      itemType: 'EXTRA_CHANNEL',
      providerSubscriptionId: '101',
      providerItemId: '901',
    },
    {
      id: 3,
      itemType: 'EXTRA_MEMBER',
      providerSubscriptionId: '102',
      providerItemId: '902',
    },
    {
      id: 4,
      itemType: 'EXTRA_WORKSPACE',
      providerSubscriptionId: '103',
      providerItemId: '903',
    },
    {
      id: 5,
      itemType: 'EXTRA_AI_TOKENS',
      providerSubscriptionId: '104',
      providerItemId: '904',
    },
  ];
}

function makeAdapter(
  rows: Row[],
  clientOverrides: Record<string, jest.Mock> = {},
) {
  const updates: { id: number; set: Record<string, unknown> }[] = [];
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(rows),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockImplementation((set: Record<string, unknown>) => ({
        where: jest.fn().mockImplementation(() => {
          updates.push({ id: -1, set });
          return Promise.resolve(undefined);
        }),
      })),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
        onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
      }),
    }),
  };

  const client = {
    get: jest.fn().mockResolvedValue({ data: { attributes: {} } }),
    post: jest.fn().mockResolvedValue({
      data: { attributes: { url: 'https://ls.test/checkout/abc' } },
    }),
    patch: jest.fn().mockResolvedValue({ data: { attributes: {} } }),
    delete: jest.fn().mockResolvedValue({
      data: { attributes: { status: 'cancelled' } },
    }),
    ...clientOverrides,
  };

  const catalogue = { resolveRef: jest.fn().mockResolvedValue('2100632') };
  const adapter = new LemonSqueezyAdapter(
    db as never,
    client as never,
    catalogue as never,
  );
  return { adapter, client, catalogue, db, updates };
}

describe('LemonSqueezyAdapter.name', () => {
  it('identifies itself as lemonsqueezy', () => {
    const { adapter } = makeAdapter([]);
    expect(adapter.name).toBe('lemonsqueezy');
  });
});

describe('LemonSqueezyAdapter.purchaseAddon', () => {
  // No POST /v1/subscription-items exists, so a NEW add-on can only start at a
  // hosted checkout.
  it('returns a checkout url for an add-on the account does not have', async () => {
    const { adapter } = makeAdapter([
      {
        id: 1,
        itemType: 'BASE_PLAN',
        providerSubscriptionId: '100',
        providerItemId: '900',
      },
    ]);
    const result = await adapter.purchaseAddon(1, 'EXTRA_CHANNEL', 2);
    expect(result).toEqual({
      status: 'checkout_required',
      url: 'https://ls.test/checkout/abc',
    });
  });

  // Verified live 2026-09-07: PATCH with invoice_immediately charged PKR 400
  // at once and left renews_at untouched.
  it('updates quantity in place when the add-on already exists', async () => {
    const { adapter, client } = makeAdapter(fiveRows());
    const result = await adapter.purchaseAddon(1, 'EXTRA_CHANNEL', 5);
    expect(result).toEqual({ status: 'completed', quantity: 5 });
    expect(client.patch).toHaveBeenCalledWith(
      'subscription-items/901',
      expect.objectContaining({
        data: expect.objectContaining({
          attributes: expect.objectContaining({
            quantity: 5,
            invoice_immediately: true,
          }),
        }),
      }),
    );
  });
});

describe('LemonSqueezyAdapter.changeAddonQuantity', () => {
  it('invoices immediately so the charge is not deferred to renewal', async () => {
    const { adapter, client } = makeAdapter(fiveRows());
    await adapter.changeAddonQuantity(1, 'EXTRA_MEMBER', 4);
    expect(client.patch).toHaveBeenCalledWith(
      'subscription-items/902',
      expect.objectContaining({
        data: expect.objectContaining({
          attributes: expect.objectContaining({ invoice_immediately: true }),
        }),
      }),
    );
  });

  // The billing quantity our row reports must follow the quantity we just
  // told the provider to charge for, or the two records disagree silently.
  it('records the new billing quantity on our own row', async () => {
    const { adapter, updates } = makeAdapter(fiveRows());
    await adapter.changeAddonQuantity(1, 'EXTRA_MEMBER', 4);
    expect(updates).toHaveLength(1);
    expect(updates[0].set).toEqual(
      expect.objectContaining({ providerQuantity: 4 }),
    );
  });

  it('throws when the account has no such add-on', async () => {
    const { adapter } = makeAdapter([
      {
        id: 1,
        itemType: 'BASE_PLAN',
        providerSubscriptionId: '100',
        providerItemId: '900',
      },
    ]);
    await expect(
      adapter.changeAddonQuantity(1, 'EXTRA_CHANNEL', 2),
    ).rejects.toThrow(/EXTRA_CHANNEL/);
  });
});

describe('LemonSqueezyAdapter.removeAddon', () => {
  // An add-on IS a whole subscription here, so removing it means cancelling
  // that subscription, not deleting a line item.
  it('cancels the add-on’s own subscription', async () => {
    const { adapter, client } = makeAdapter(fiveRows());
    await adapter.removeAddon(1, 'EXTRA_CHANNEL');
    expect(client.delete).toHaveBeenCalledWith('subscriptions/101');
  });

  // Cancelling at the provider without writing our row would leave the add-on
  // reading active here while it is cancelled there — a divergence nothing
  // would notice until reconciliation. Dropping the write must fail a test.
  it('records the cancellation on our own row', async () => {
    const { adapter, updates } = makeAdapter(fiveRows());
    await adapter.removeAddon(1, 'EXTRA_CHANNEL');
    expect(updates).toHaveLength(1);
    expect(updates[0].set).toEqual(
      expect.objectContaining({ providerStatus: 'cancelled' }),
    );
  });
});

describe('LemonSqueezyAdapter.cancel', () => {
  it('cancels every one of the five subscriptions', async () => {
    const { adapter, client } = makeAdapter(fiveRows());
    await adapter.cancel(1, true);
    expect(client.delete).toHaveBeenCalledTimes(5);
  });

  // Load-bearing. If the fan-out breaks midway the customer must still hold
  // the base plan; cancelling it first would end access while add-ons billed.
  it('cancels the base plan LAST', async () => {
    const { adapter, client } = makeAdapter(fiveRows());
    await adapter.cancel(1, true);
    const paths = client.delete.mock.calls.map((c: string[]) => c[0]);
    expect(paths[paths.length - 1]).toBe('subscriptions/100');
  });

  it('leaves the base plan alive when an add-on cancel fails midway', async () => {
    const failing = jest
      .fn()
      .mockResolvedValueOnce({ data: { attributes: { status: 'cancelled' } } })
      .mockRejectedValueOnce(new Error('provider 500'));
    const { adapter } = makeAdapter(fiveRows(), { delete: failing });

    await expect(adapter.cancel(1, true)).rejects.toThrow('provider 500');
    const paths = failing.mock.calls.map((c: string[]) => c[0]);
    expect(paths).not.toContain('subscriptions/100');
  });

  // A break midway must leave the database telling the truth about which rows
  // were actually cancelled, so reconciliation can repair it.
  it('records each cancellation as it happens, not after the whole fan-out', async () => {
    const failing = jest
      .fn()
      .mockResolvedValueOnce({ data: { attributes: { status: 'cancelled' } } })
      .mockRejectedValueOnce(new Error('provider 500'));
    const { adapter, db } = makeAdapter(fiveRows(), { delete: failing });

    await expect(adapter.cancel(1, true)).rejects.toThrow();
    expect(db.update).toHaveBeenCalledTimes(1);
  });
});

describe('LemonSqueezyAdapter.pause / resume', () => {
  // behavior 'void', not keep_as_draft: a returning customer must not be
  // handed a stack of back-invoices.
  it('pauses with mode void', async () => {
    const { adapter, client } = makeAdapter(fiveRows());
    await adapter.pause(1);
    expect(client.patch).toHaveBeenCalledWith(
      'subscriptions/100',
      expect.objectContaining({
        data: expect.objectContaining({
          attributes: expect.objectContaining({
            pause: { mode: 'void' },
          }),
        }),
      }),
    );
  });

  it('resumes by clearing the pause', async () => {
    const { adapter, client } = makeAdapter(fiveRows());
    await adapter.resume(1);
    expect(client.patch).toHaveBeenCalledWith(
      'subscriptions/100',
      expect.objectContaining({
        data: expect.objectContaining({
          attributes: expect.objectContaining({ pause: null }),
        }),
      }),
    );
  });

  it('pauses add-ons too, so nothing keeps billing while paused', async () => {
    const { adapter, client } = makeAdapter(fiveRows());
    await adapter.pause(1);
    expect(client.patch).toHaveBeenCalledTimes(5);
  });
});

describe('LemonSqueezyAdapter checkout redirect', () => {
  const OLD_FRONTEND = process.env.FRONTEND_URL;
  const OLD_STORE = process.env.LEMONSQUEEZY_STORE_ID;

  beforeEach(() => {
    process.env.FRONTEND_URL = 'https://app.test';
    process.env.LEMONSQUEEZY_STORE_ID = '462839';
  });

  afterEach(() => {
    if (OLD_FRONTEND === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = OLD_FRONTEND;
    if (OLD_STORE === undefined) delete process.env.LEMONSQUEEZY_STORE_ID;
    else process.env.LEMONSQUEEZY_STORE_ID = OLD_STORE;
  });

  /** The posted checkout body, whatever the call shape. */
  function postedBody(client: { post: jest.Mock }): {
    data: { attributes: Record<string, unknown> };
  } {
    const calls = client.post.mock.calls as unknown[][];
    return calls[0][1] as { data: { attributes: Record<string, unknown> } };
  }

  it('sends the customer back to the workspace plans page', async () => {
    const { adapter, client } = makeAdapter([]);

    await adapter.createCheckout('user-1', 'BASIC', 'ws-9');

    const attrs = postedBody(client).data.attributes;
    expect(attrs.product_options).toEqual({
      redirect_url: 'https://app.test/w/ws-9/settings/plans?checkout=success',
    });
  });

  // The param Stripe already sends; `plans-shell.tsx` keys its success toast
  // and its poll-until-the-plan-flips on it, so both providers must match.
  it('uses the same ?checkout=success param as the Stripe adapter', async () => {
    const { adapter, client } = makeAdapter([]);

    await adapter.createCheckout('user-1', 'PRO', 'ws-9');

    const opts = postedBody(client).data.attributes.product_options as {
      redirect_url: string;
    };
    expect(opts.redirect_url).toContain('?checkout=success');
    expect(opts.redirect_url).toContain('/settings/plans');
  });

  // `/settings/plans` only exists nested under `/w/:workspaceId`, so an add-on
  // checkout — which has no workspace — must send NO redirect rather than a
  // URL that would 404.
  it('omits product_options entirely for an add-on checkout', async () => {
    // `purchaseAddon` reads the account from `subscriptions` before opening a
    // checkout, so the row has to exist — and it carries no workspace, which
    // is exactly why this checkout cannot be given a redirect.
    const { adapter, client } = makeAdapter([
      { userId: 'user-1', planCode: 'PRO' } as never,
    ]);

    await adapter.purchaseAddon(1, 'EXTRA_CHANNEL', 2);

    const attrs = postedBody(client).data.attributes;
    expect(attrs).not.toHaveProperty('product_options');
  });

  it('falls back to localhost when FRONTEND_URL is unset', async () => {
    delete process.env.FRONTEND_URL;
    const { adapter, client } = makeAdapter([]);

    await adapter.createCheckout('user-1', 'BASIC', 'ws-9');

    const opts = postedBody(client).data.attributes.product_options as {
      redirect_url: string;
    };
    expect(opts.redirect_url).toBe(
      'http://localhost:3001/w/ws-9/settings/plans?checkout=success',
    );
  });
});

describe('LemonSqueezyAdapter portal, invoices and billing profile', () => {
  const OLD_KEY = process.env.LEMONSQUEEZY_API_KEY;
  const OLD_FETCH = global.fetch;
  const NOW = Date.parse('2026-11-17T12:00:00Z');

  beforeEach(() => {
    process.env.LEMONSQUEEZY_API_KEY = 'test-key';
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
  });
  afterEach(() => {
    jest.useRealTimers();
    global.fetch = OLD_FETCH;
    if (OLD_KEY === undefined) delete process.env.LEMONSQUEEZY_API_KEY;
    else process.env.LEMONSQUEEZY_API_KEY = OLD_KEY;
  });

  /** Answers each request from `routes`, matched by substring of the URL. */
  function stubFetch(routes: Record<string, unknown>) {
    const fn = jest.fn((url: string) => {
      const key = Object.keys(routes).find((k) => url.includes(k));
      return Promise.resolve({
        ok: key !== undefined,
        status: key !== undefined ? 200 : 404,
        text: () => Promise.resolve(JSON.stringify(key ? routes[key] : {})),
      });
    });
    (global as unknown as { fetch: unknown }).fetch = fn;
    return fn;
  }

  /** Real client over the stubbed fetch; the db answers per table. */
  function build(rows: Row[]) {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockImplementation((table: unknown) => ({
          where: jest
            .fn()
            .mockResolvedValue(
              table === subscriptions
                ? [{ userId: 'user-1', planCode: 'PRO' }]
                : rows,
            ),
        })),
      }),
    };
    const catalogue = {
      planName: jest.fn().mockResolvedValue('Pro'),
      addonName: jest.fn((t: string) =>
        t === 'EXTRA_CHANNEL' ? 'Extra Channel' : t,
      ),
    };
    return new LemonSqueezyAdapter(
      db as never,
      new LemonSqueezyClient(),
      catalogue as never,
    );
  }

  const BASE: Row = {
    id: 1,
    itemType: 'BASE_PLAN',
    providerSubscriptionId: '100',
    providerItemId: '900',
  };
  const CHANNEL: Row = {
    id: 2,
    itemType: 'EXTRA_CHANNEL',
    providerSubscriptionId: '101',
    providerItemId: '901',
  };

  const inv = (
    id: string,
    createdAt: string,
    over: Record<string, unknown> = {},
  ) => ({
    id,
    attributes: {
      created_at: createdAt,
      status: 'paid',
      billing_reason: 'renewal',
      total: 1900,
      currency: 'USD',
      urls: { invoice_url: `https://ls.test/invoice/${id}` },
      ...over,
    },
  });

  describe('createPortalLink', () => {
    const SUB = {
      data: {
        attributes: {
          urls: {
            customer_portal: 'https://ls.test/portal',
            update_payment_method: 'https://ls.test/card',
          },
        },
      },
    };

    it('opens the card form for update_payment_method, from the base subscription', async () => {
      const fetchMock = stubFetch({ 'subscriptions/100': SUB });

      const out = await build([BASE, CHANNEL]).createPortalLink(
        1,
        'update_payment_method',
      );

      expect(out).toEqual({ url: 'https://ls.test/card' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api.lemonsqueezy.com/v1/subscriptions/100',
      );
    });

    it('accepts, and ignores, the workspace a caller names', async () => {
      stubFetch({ 'subscriptions/100': SUB });
      await expect(
        build([BASE]).createPortalLink(1, 'portal', { workspaceId: 'ws-1' }),
      ).resolves.toEqual({ url: 'https://ls.test/portal' });
    });

    it('opens the customer portal for the portal intent', async () => {
      stubFetch({ 'subscriptions/100': SUB });
      await expect(
        build([BASE]).createPortalLink(1, 'portal'),
      ).resolves.toEqual({ url: 'https://ls.test/portal' });
    });

    it('answers 502 PORTAL_UNAVAILABLE when the provider returns no url', async () => {
      stubFetch({
        'subscriptions/100': { data: { attributes: { urls: {} } } },
      });
      // The adapter logs this loudly on purpose; keep the test output clean.
      const logged = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      const err = (await build([BASE])
        .createPortalLink(1, 'portal')
        .catch((e: unknown) => e)) as {
        getStatus(): number;
        getResponse(): unknown;
      };

      expect(err.getStatus()).toBe(502);
      expect(err.getResponse()).toMatchObject({
        statusCode: 502,
        code: 'PORTAL_UNAVAILABLE',
      });
      expect(logged).toHaveBeenCalled();
      logged.mockRestore();
    });
  });

  describe('listInvoices', () => {
    function twoLists() {
      return stubFetch({
        'filter%5Bsubscription_id%5D=100': {
          data: [
            inv('a1', '2026-10-01T00:00:00Z'),
            inv('a2', '2026-11-01T00:00:00Z'),
          ],
        },
        'filter%5Bsubscription_id%5D=101': {
          data: [inv('b1', '2026-10-15T00:00:00Z', { total: 500 })],
        },
      });
    }

    it('merges every provider row newest first and maps the fields', async () => {
      const fetchMock = twoLists();

      const out = await build([BASE, CHANNEL]).listInvoices(1, 10);

      expect(out.map((i) => i.id)).toEqual(['a2', 'b1', 'a1']);
      expect(out[1]).toEqual({
        id: 'b1',
        date: '2026-10-15T00:00:00Z',
        description: 'Extra Channel',
        amountCents: 500,
        currency: 'USD',
        status: 'paid',
        downloadUrl: 'https://ls.test/invoice/b1',
      });
      expect(out[0].description).toBe('Pro plan');
      const urls = fetchMock.mock.calls.map((c) => c[0]);
      expect(urls).toHaveLength(2);
      expect(urls[0]).toContain('filter%5Bsubscription_id%5D=100');
      expect(urls[0]).toContain('page%5Bsize%5D=10');
      expect(urls[1]).toContain('filter%5Bsubscription_id%5D=101');
    });

    it('returns only the newest `limit` of the merged list', async () => {
      twoLists();
      const out = await build([BASE, CHANNEL]).listInvoices(1, 2);
      expect(out.map((i) => i.id)).toEqual(['a2', 'b1']);
    });

    it('returns nothing, and calls nothing, for an account with no provider rows', async () => {
      const fetchMock = stubFetch({});
      await expect(build([]).listInvoices(1, 10)).resolves.toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    describe('status', () => {
      async function statusOf(
        createdAt: string,
        attrs: Record<string, unknown>,
      ) {
        stubFetch({
          'subscription_id%5D=100': { data: [inv('x', createdAt, attrs)] },
        });
        return (await build([BASE]).listInvoices(1, 5))[0].status;
      }
      // NOW is 12:00 on the 17th.
      const TWO_HOURS_OLD = '2026-11-17T10:00:00Z';
      const HALF_HOUR_OLD = '2026-11-17T11:30:00Z';

      it('maps refunded and partial_refund to refunded', async () => {
        await expect(
          statusOf(TWO_HOURS_OLD, { status: 'refunded' }),
        ).resolves.toBe('refunded');
        await expect(
          statusOf(TWO_HOURS_OLD, { status: 'partial_refund' }),
        ).resolves.toBe('refunded');
      });
      it('maps void to void', async () => {
        await expect(statusOf(TWO_HOURS_OLD, { status: 'void' })).resolves.toBe(
          'void',
        );
      });
      it('calls a renewal still pending after 2 hours failed', async () => {
        await expect(
          statusOf(TWO_HOURS_OLD, {
            status: 'pending',
            billing_reason: 'renewal',
          }),
        ).resolves.toBe('failed');
      });
      it('keeps a pending renewal under an hour old pending', async () => {
        await expect(
          statusOf(HALF_HOUR_OLD, {
            status: 'pending',
            billing_reason: 'renewal',
          }),
        ).resolves.toBe('pending');
      });
      it('keeps an old pending invoice that is not a renewal pending', async () => {
        await expect(
          statusOf(TWO_HOURS_OLD, {
            status: 'pending',
            billing_reason: 'initial',
          }),
        ).resolves.toBe('pending');
      });
    });
  });

  describe('getBillingProfile', () => {
    it('maps the card from the subscription and the contact from the customer', async () => {
      const fetchMock = stubFetch({
        'subscriptions/100': {
          data: {
            attributes: {
              customer_id: 77,
              card_brand: 'visa',
              card_last_four: '4242',
            },
          },
        },
        'customers/77': {
          data: {
            attributes: { name: 'Ada', email: 'ada@x.test', country: 'GB' },
          },
        },
      });

      const out = await build([BASE, CHANNEL]).getBillingProfile(1);

      expect(out).toEqual({
        card: { brand: 'visa', last4: '4242' },
        billingDetails: { name: 'Ada', email: 'ada@x.test', country: 'GB' },
      });
      expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
        'https://api.lemonsqueezy.com/v1/subscriptions/100',
        'https://api.lemonsqueezy.com/v1/customers/77',
      ]);
    });

    it('reports no card when the subscription has none on file', async () => {
      stubFetch({
        'subscriptions/100': {
          data: {
            attributes: {
              customer_id: 77,
              card_brand: null,
              card_last_four: null,
            },
          },
        },
        'customers/77': { data: { attributes: { name: null } } },
      });

      const out = await build([BASE]).getBillingProfile(1);

      expect(out.card).toBeNull();
      expect(out.billingDetails).toEqual({
        name: null,
        email: null,
        country: null,
      });
    });
  });
});
