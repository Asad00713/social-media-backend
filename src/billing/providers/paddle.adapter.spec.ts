import { PaddleAdapter } from './paddle.adapter';
import type { PaddleSubscriptionItem } from './paddle.types';

/**
 * The `id` a drizzle `eq(column, value)` binds, so the update fake can land
 * its patch on the right row. Mirrors `stripe.adapter.spec.ts`.
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
function boundId(condition: unknown): unknown {
  const chunks = (condition as any)?.queryChunks as unknown[] | undefined;
  if (!Array.isArray(chunks)) return undefined;
  for (const chunk of chunks) {
    if (chunk && typeof chunk === 'object' && 'value' in (chunk as any)) {
      const v = (chunk as any).value;
      if (!Array.isArray(v)) return v;
    }
  }
  return undefined;
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access */
/* eslint-enable @typescript-eslint/no-unsafe-assignment */

function item(priceId: string, quantity: number): PaddleSubscriptionItem {
  return {
    price: { id: priceId, product_id: `pro_${priceId}` },
    quantity,
  };
}

interface Options {
  /** What `GET /subscriptions/{id}` answers with. */
  liveItems?: PaddleSubscriptionItem[];
  /** What `rowsFor` finds. */
  rows?: Record<string, unknown>[];
  /** What the `users` select answers with. */
  user?: { email: string; name: string | null };
}

function makeAdapter(opts: Options = {}) {
  const rows = opts.rows ?? [];
  const liveItems = opts.liveItems ?? [item('pri_base', 1)];
  const user = opts.user ?? { email: 'owner@example.com', name: 'Owner' };

  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];

  /**
   * The select fake answers by TABLE, because this adapter reads three:
   * `provider_subscriptions` (unprojected), `subscriptions` and `users` (both
   * projected). Keying on the projection is what keeps `accountOf` from being
   * handed provider rows.
   */
  const db = {
    select: jest.fn((projection?: Record<string, unknown>) => ({
      from: jest.fn(() => ({
        where: jest.fn(() => {
          if (!projection) return Promise.resolve(rows);
          const keys = Object.keys(projection);
          if (keys.includes('email')) return Promise.resolve([user]);
          if (keys.includes('planCode'))
            return Promise.resolve([{ userId: 'u1', planCode: 'PRO' }]);
          return Promise.resolve(rows);
        }),
      })),
    })),
    update: jest.fn(() => ({
      set: jest.fn((v: Record<string, unknown>) => {
        updates.push(v);
        return {
          where: jest.fn((cond: unknown) => {
            const id = boundId(cond);
            for (const row of rows) {
              if (id === undefined || row.id === id) Object.assign(row, v);
            }
            return Promise.resolve(undefined);
          }),
        };
      }),
    })),
    insert: jest.fn(() => ({
      values: jest.fn((v: Record<string, unknown>) => {
        inserts.push(v);
        return { onConflictDoUpdate: jest.fn().mockResolvedValue(undefined) };
      }),
    })),
  };

  /** Every PATCH body, in order — the whole point of most tests here. */
  const patches: { path: string; body: any }[] = [];
  const posts: { path: string; body: any }[] = [];

  const paddle = {
    get: jest.fn((path: string) => {
      if (path.startsWith('subscriptions/')) {
        return Promise.resolve({
          data: {
            id: 'sub_paddle_1',
            status: 'active',
            customer_id: 'ctm_1',
            items: liveItems,
          },
        });
      }
      if (path.startsWith('customers?email=')) {
        return Promise.resolve({ data: [] });
      }
      if (path.startsWith('customers/')) {
        return Promise.resolve({
          data: { id: 'ctm_1', email: user.email, name: user.name },
        });
      }
      if (path.startsWith('transactions?')) {
        return Promise.resolve({ data: [] });
      }
      return Promise.resolve({ data: {} });
    }),
    post: jest.fn((path: string, body: unknown) => {
      posts.push({ path, body });
      if (path === 'transactions') {
        return Promise.resolve({
          data: { id: 'txn_1', checkout: { url: 'https://pay.paddle.test/1' } },
        });
      }
      if (path === 'customers') {
        return Promise.resolve({ data: { id: 'ctm_new' } });
      }
      if (path.includes('portal-sessions')) {
        return Promise.resolve({
          data: {
            urls: {
              general: { overview: 'https://portal.paddle.test/overview' },
              subscriptions: [
                {
                  id: 'sub_paddle_1',
                  update_subscription_payment_method:
                    'https://portal.paddle.test/card',
                },
              ],
            },
          },
        });
      }
      return Promise.resolve({ data: {} });
    }),
    patch: jest.fn((path: string, body: unknown) => {
      patches.push({ path, body });
      return Promise.resolve({ data: {} });
    }),
  };

  const catalogue = {
    resolveRef: jest.fn().mockResolvedValue('pri_resolved'),
    planName: jest.fn().mockResolvedValue('Pro'),
  };
  const links = { billing: jest.fn(() => 'https://app.test/billing') };

  const adapter = new PaddleAdapter(
    db as never,
    paddle as never,
    catalogue as never,
    links as never,
  );
  return { adapter, paddle, catalogue, links, inserts, updates, patches, posts, rows };
}

/** A loaded account: Pro plus three add-ons, all on one Paddle subscription. */
const LOADED_ROWS = [
  {
    id: 1,
    itemType: 'BASE_PLAN',
    provider: 'paddle',
    providerSubscriptionId: 'sub_paddle_1',
    providerCustomerId: 'ctm_1',
    providerPriceId: 'pri_base',
    isDefault: true,
  },
  {
    id: 2,
    itemType: 'EXTRA_CHANNEL',
    provider: 'paddle',
    providerSubscriptionId: 'sub_paddle_1',
    providerCustomerId: 'ctm_1',
    providerPriceId: 'pri_channel',
    isDefault: false,
  },
];

const LOADED_ITEMS = [
  item('pri_base', 1),
  item('pri_channel', 4),
  item('pri_member', 2),
];

describe('PaddleAdapter', () => {
  it('identifies itself as paddle', () => {
    expect(makeAdapter().adapter.name).toBe('paddle');
  });

  // -------------------------------------------------------------- checkout

  describe('createCheckout', () => {
    it('creates a transaction and returns its checkout URL', async () => {
      // Paddle has no "create subscription" endpoint: a new subscription
      // begins as a transaction, and Paddle makes the subscription itself
      // once that transaction is paid.
      const { adapter, posts } = makeAdapter();
      await expect(adapter.createCheckout('u1', 'PRO', 'ws-1')).resolves.toEqual(
        { url: 'https://pay.paddle.test/1' },
      );
      const txn = posts.find((p) => p.path === 'transactions');
      expect(txn?.body.items).toEqual([
        { price_id: 'pri_resolved', quantity: 1 },
      ]);
      expect(txn?.body.collection_mode).toBe('automatic');
    });

    it('carries the workspace in custom_data, for the webhook to read back', async () => {
      // The transaction is the ONLY place that knows which workspace asked
      // for the plan. Without this the webhook that creates the subscription
      // cannot tell where it belongs.
      const { adapter, posts } = makeAdapter();
      await adapter.createCheckout('u1', 'PRO', 'ws-1');
      const txn = posts.find((p) => p.path === 'transactions');
      expect(txn?.body.custom_data).toEqual({
        workspace_id: 'ws-1',
        user_id: 'u1',
        plan_code: 'PRO',
      });
    });

    it('writes NO provider_subscriptions row yet', async () => {
      // There is no subscription id to write: Paddle mints one when the
      // transaction completes. A row written here would hold a transaction id
      // in a column every other call treats as a subscription id.
      const { adapter, inserts } = makeAdapter();
      await adapter.createCheckout('u1', 'PRO', 'ws-1');
      expect(inserts).toEqual([]);
    });

    it('reuses an existing Paddle customer rather than creating a second', async () => {
      // A duplicate customer splits one person's billing history in two, and
      // Paddle's docs do not say what POST /customers does for an email it
      // already has.
      const { adapter, paddle, posts } = makeAdapter();
      (paddle.get as jest.Mock).mockImplementation((path: string) => {
        if (path.startsWith('customers?email='))
          return Promise.resolve({ data: [{ id: 'ctm_existing' }] });
        if (path.startsWith('subscriptions/'))
          return Promise.resolve({ data: { items: [] } });
        return Promise.resolve({ data: {} });
      });

      await adapter.createCheckout('u1', 'PRO', 'ws-1');
      expect(posts.some((p) => p.path === 'customers')).toBe(false);
      const txn = posts.find((p) => p.path === 'transactions');
      expect(txn?.body.customer_id).toBe('ctm_existing');
    });

    it('creates a customer when the email is unknown', async () => {
      const { adapter, posts } = makeAdapter();
      await adapter.createCheckout('u1', 'PRO', 'ws-1');
      const created = posts.find((p) => p.path === 'customers');
      expect(created?.body.email).toBe('owner@example.com');
      expect(posts.find((p) => p.path === 'transactions')?.body.customer_id).toBe(
        'ctm_new',
      );
    });

    it('refuses when Paddle returns no checkout URL', async () => {
      // `checkout.url` is null for a draft transaction. An empty string here
      // would send the customer to a blank page.
      const { adapter, paddle } = makeAdapter();
      (paddle.post as jest.Mock).mockImplementation((path: string) =>
        path === 'transactions'
          ? Promise.resolve({ data: { id: 'txn_draft', checkout: null } })
          : Promise.resolve({ data: { id: 'ctm_new' } }),
      );
      await expect(
        adapter.createCheckout('u1', 'PRO', 'ws-1'),
      ).rejects.toThrow(/txn_draft/);
    });

    it('refuses a user with no email', async () => {
      const { adapter } = makeAdapter({
        user: { email: '', name: null },
      });
      await expect(
        adapter.createCheckout('u1', 'PRO', 'ws-1'),
      ).rejects.toThrow(/no email/i);
    });
  });

  // ------------------------------------------------------------------ plan

  describe('changePlan', () => {
    it('swaps the base price and KEEPS every add-on at its quantity', async () => {
      // The whole hazard of Paddle's replace-the-array update. Someone moving
      // Basic -> Pro must not lose the extra channels they are paying for.
      const { adapter, patches } = makeAdapter({
        rows: structuredClone(LOADED_ROWS),
        liveItems: LOADED_ITEMS,
      });
      await adapter.changePlan(1, 'MAX', 'up');

      expect(patches).toHaveLength(1);
      expect(patches[0].body.items).toEqual([
        { price_id: 'pri_resolved', quantity: 1 },
        { price_id: 'pri_channel', quantity: 4 },
        { price_id: 'pri_member', quantity: 2 },
      ]);
    });

    it('charges the rest of the period on an UPGRADE', async () => {
      // Buy more capacity on the 15th of a monthly cycle and about half the
      // difference is collected now, which is what the plan UI promises and
      // what Stripe does. The field is also REQUIRED whenever items change;
      // without it the call is a 400 that reads as a Paddle outage.
      const { adapter, patches } = makeAdapter({
        rows: structuredClone(LOADED_ROWS),
        liveItems: LOADED_ITEMS,
      });
      await adapter.changePlan(1, 'MAX', 'up');
      expect(patches[0].body.proration_billing_mode).toBe(
        'prorated_immediately',
      );
    });

    it('bills NOTHING on a DOWNGRADE', async () => {
      // `plan-change.service.ts` swaps the price now but keeps the customer
      // on the old plan until `currentPeriodEnd`, and its comment says "with
      // no proration". Prorating here would credit back half a month the
      // customer then goes on using in full — our loss, and a refund nobody
      // asked for.
      const { adapter, patches } = makeAdapter({
        rows: structuredClone(LOADED_ROWS),
        liveItems: LOADED_ITEMS,
      });
      await adapter.changePlan(1, 'BASIC', 'down');
      expect(patches[0].body.proration_billing_mode).toBe('do_not_bill');
    });

    it('records the new price on our own row', async () => {
      const { adapter, updates } = makeAdapter({
        rows: structuredClone(LOADED_ROWS),
        liveItems: LOADED_ITEMS,
      });
      await adapter.changePlan(1, 'MAX', 'up');
      expect(updates[0]).toMatchObject({ providerPriceId: 'pri_resolved' });
    });

    it('does nothing when the plan is already the target', async () => {
      // A no-op PATCH would bill a proration of zero and emit a
      // subscription.updated for a change that did not happen.
      const rows = structuredClone(LOADED_ROWS);
      rows[0].providerPriceId = 'pri_resolved';
      const { adapter, patches, updates } = makeAdapter({
        rows,
        liveItems: [item('pri_resolved', 1)],
      });
      await adapter.changePlan(1, 'PRO', 'up');
      expect(patches).toEqual([]);
      expect(updates).toEqual([]);
    });

    it('refuses when our row names a price the subscription does not carry', async () => {
      // Rather than guessing which of the live items is the plan — the guess
      // that silently deletes an add-on.
      const rows = structuredClone(LOADED_ROWS);
      rows[0].providerPriceId = 'pri_stale';
      const { adapter } = makeAdapter({ rows, liveItems: LOADED_ITEMS });
      await expect(adapter.changePlan(1, 'MAX', 'up')).rejects.toThrow(
        /refusing to guess/,
      );
    });
  });

  // --------------------------------------------------------------- add-ons

  describe('purchaseAddon', () => {
    it('completes server-side, with no checkout redirect', async () => {
      // Unlike Lemon Squeezy, where a brand-new add-on must start at a hosted
      // checkout.
      const { adapter } = makeAdapter({
        rows: structuredClone(LOADED_ROWS),
        liveItems: LOADED_ITEMS,
      });
      await expect(
        adapter.purchaseAddon(1, 'EXTRA_MEMBER', 3),
      ).resolves.toEqual({ status: 'completed', quantity: 3 });
    });

    it('sends the whole items list, not only the new line', async () => {
      const { adapter, patches } = makeAdapter({
        rows: structuredClone(LOADED_ROWS),
        liveItems: LOADED_ITEMS,
      });
      await adapter.purchaseAddon(1, 'EXTRA_WORKSPACE', 2);
      expect(patches[0].body.items).toEqual([
        { price_id: 'pri_base', quantity: 1 },
        { price_id: 'pri_channel', quantity: 4 },
        { price_id: 'pri_member', quantity: 2 },
        { price_id: 'pri_resolved', quantity: 2 },
      ]);
    });

    it('charges the rest of the period for a new add-on', async () => {
      // A purchase only ever adds or raises a line: buy a $5 channel on the
      // 15th and about $2.50 is collected, not $5.
      const { adapter, patches } = makeAdapter({
        rows: structuredClone(LOADED_ROWS),
        liveItems: LOADED_ITEMS,
      });
      await adapter.purchaseAddon(1, 'EXTRA_WORKSPACE', 2);
      expect(patches[0].body.proration_billing_mode).toBe(
        'prorated_immediately',
      );
    });

    it('writes the bookkeeping row with isDefault FALSE', async () => {
      // `0032` has a partial unique index on (subscription_id) WHERE
      // is_default. Setting it here would hit a 23505 AFTER Paddle had
      // already put the billable line on the subscription: charged customer,
      // 500 response, no row.
      const { adapter, inserts } = makeAdapter({
        rows: structuredClone(LOADED_ROWS),
        liveItems: LOADED_ITEMS,
      });
      await adapter.purchaseAddon(1, 'EXTRA_WORKSPACE', 2);
      expect(inserts[0]).toMatchObject({
        provider: 'paddle',
        itemType: 'EXTRA_WORKSPACE',
        providerSubscriptionId: 'sub_paddle_1',
        providerPriceId: 'pri_resolved',
        providerQuantity: 2,
        isDefault: false,
      });
    });

    it('refuses when the account has no base plan to add to', async () => {
      const { adapter } = makeAdapter({
        rows: [
          {
            id: 9,
            itemType: 'EXTRA_CHANNEL',
            provider: 'paddle',
            providerSubscriptionId: 'sub_paddle_1',
            providerPriceId: 'pri_channel',
            isDefault: false,
          },
        ],
      });
      await expect(adapter.purchaseAddon(1, 'EXTRA_MEMBER', 1)).rejects.toThrow(
        /BASE_PLAN/,
      );
    });

    it('does not act on a row belonging to another provider', async () => {
      // During a migration window two rows can share an itemType. Picking by
      // itemType alone would hand a Lemon Squeezy id to a Paddle call.
      const { adapter } = makeAdapter({
        rows: [
          {
            id: 1,
            itemType: 'BASE_PLAN',
            provider: 'lemonsqueezy',
            providerSubscriptionId: 'ls_1',
            providerPriceId: 'ls_price',
            isDefault: true,
          },
        ],
      });
      await expect(adapter.purchaseAddon(1, 'EXTRA_MEMBER', 1)).rejects.toThrow(
        /no paddle BASE_PLAN/i,
      );
    });
  });

  describe('changeAddonQuantity', () => {
    it('updates the line and keeps the others', async () => {
      const { adapter, patches } = makeAdapter({
        rows: structuredClone(LOADED_ROWS),
        liveItems: LOADED_ITEMS,
      });
      await adapter.changeAddonQuantity(1, 'EXTRA_CHANNEL', 9);
      expect(patches[0].body.items).toEqual([
        { price_id: 'pri_base', quantity: 1 },
        { price_id: 'pri_channel', quantity: 9 },
        { price_id: 'pri_member', quantity: 2 },
      ]);
    });

    it('skips the call when Paddle already bills that quantity', async () => {
      const { adapter, patches, updates } = makeAdapter({
        rows: structuredClone(LOADED_ROWS),
        liveItems: LOADED_ITEMS,
      });
      await adapter.changeAddonQuantity(1, 'EXTRA_CHANNEL', 4);
      expect(patches).toEqual([]);
      // Our own count is still written: it may have drifted from Paddle's.
      expect(updates[0]).toMatchObject({ providerQuantity: 4 });
    });

    it('charges the rest of the period when the quantity goes UP', async () => {
      const { adapter, patches } = makeAdapter({
        rows: structuredClone(LOADED_ROWS),
        liveItems: LOADED_ITEMS,
      });
      await adapter.changeAddonQuantity(1, 'EXTRA_CHANNEL', 9);
      expect(patches[0].body.proration_billing_mode).toBe(
        'prorated_immediately',
      );
    });

    it('bills NOTHING when the quantity goes DOWN', async () => {
      // Direction is read from what Paddle currently bills, because this one
      // call serves both. Crediting a reduction would refund part of a month
      // the customer had already bought and could still use.
      const { adapter, patches } = makeAdapter({
        rows: structuredClone(LOADED_ROWS),
        liveItems: LOADED_ITEMS,
      });
      await adapter.changeAddonQuantity(1, 'EXTRA_CHANNEL', 2);
      expect(patches[0].body.proration_billing_mode).toBe('do_not_bill');
    });

    it('refuses when no price is recorded for the add-on', async () => {
      // The items list cannot be built without it, and guessing would send a
      // line for the wrong product.
      const rows = structuredClone(LOADED_ROWS);
      rows[1].providerPriceId = null as never;
      const { adapter } = makeAdapter({ rows, liveItems: LOADED_ITEMS });
      await expect(
        adapter.changeAddonQuantity(1, 'EXTRA_CHANNEL', 2),
      ).rejects.toThrow(/no Paddle price recorded/);
    });
  });

  describe('removeAddon', () => {
    it('drops the line and keeps the rest', async () => {
      const { adapter, patches } = makeAdapter({
        rows: structuredClone(LOADED_ROWS),
        liveItems: LOADED_ITEMS,
      });
      await adapter.removeAddon(1, 'EXTRA_CHANNEL');
      expect(patches[0].body.items).toEqual([
        { price_id: 'pri_base', quantity: 1 },
        { price_id: 'pri_member', quantity: 2 },
      ]);
    });

    it('gives no mid-period credit for a removal', async () => {
      // The month was bought and it runs to the end — Stripe's behaviour and
      // the industry default. Switching to a pro-rata credit is a one-line
      // change to PRORATION_DOWN.
      const { adapter, patches } = makeAdapter({
        rows: structuredClone(LOADED_ROWS),
        liveItems: LOADED_ITEMS,
      });
      await adapter.removeAddon(1, 'EXTRA_CHANNEL');
      expect(patches[0].body.proration_billing_mode).toBe('do_not_bill');
    });

    it('marks the row canceled, the spelling the liveness deny-list knows', async () => {
      // `isLive` is a DENY-LIST that fails open, so an unrecognised status
      // reads as STILL BILLING — which is how a removed add-on once stayed
      // eligible to inherit is_default.
      const { adapter, updates } = makeAdapter({
        rows: structuredClone(LOADED_ROWS),
        liveItems: LOADED_ITEMS,
      });
      await adapter.removeAddon(1, 'EXTRA_CHANNEL');
      expect(updates[0]).toMatchObject({ providerStatus: 'canceled' });
    });

    it('refuses to empty the subscription', async () => {
      // Paddle rejects an empty items array, and the user would read that 400
      // as "removing my add-on failed for an unknown reason".
      const rows = [
        {
          id: 1,
          itemType: 'BASE_PLAN',
          provider: 'paddle',
          providerSubscriptionId: 'sub_paddle_1',
          providerPriceId: 'pri_base',
          isDefault: true,
        },
      ];
      const { adapter } = makeAdapter({
        rows,
        liveItems: [item('pri_base', 1)],
      });
      await expect(adapter.removeAddon(1, 'BASE_PLAN')).rejects.toThrow(
        /Cancel the subscription instead/,
      );
    });
  });

  // ---------------------------------------------------- cancel/pause/resume

  describe('cancel', () => {
    it('cancels at the period end when asked to', async () => {
      const { adapter, posts } = makeAdapter({
        rows: structuredClone(LOADED_ROWS),
      });
      await adapter.cancel(1, true);
      expect(posts[0]).toEqual({
        path: 'subscriptions/sub_paddle_1/cancel',
        body: { effective_from: 'next_billing_period' },
      });
    });

    it('cancels immediately when asked to', async () => {
      const { adapter, posts } = makeAdapter({
        rows: structuredClone(LOADED_ROWS),
      });
      await adapter.cancel(1, false);
      expect(posts[0].body).toEqual({ effective_from: 'immediately' });
    });

    it('records an immediate cancel locally and frees the default slot', async () => {
      // Paddle fires `subscription.canceled` ASYNCHRONOUSLY even for
      // `immediately`. Until it lands the row still reads active and default,
      // so `isLive()` answers TRUE for a subscription that is already gone:
      // the customer is told "canceled" while still showing as paid, a second
      // cancel is accepted and re-POSTs, and a signup at another provider
      // raises 23505 on the one-default index AFTER that provider took the
      // money. A lost webhook leaves the account paid-looking forever.
      const { adapter, updates } = makeAdapter({
        rows: structuredClone(LOADED_ROWS),
      });

      await adapter.cancel(1, false);

      expect(updates[0]).toMatchObject({
        providerStatus: 'canceled',
        isDefault: false,
      });
    });

    it('a SCHEDULED cancel keeps the default slot — it is still billing', async () => {
      // Until the period ends the account is still Paddle's, so handing the
      // slot away would make `hasLiveBasePlan` false for a paying customer.
      const { adapter, updates } = makeAdapter({
        rows: structuredClone(LOADED_ROWS),
      });

      await adapter.cancel(1, true);

      expect(updates[0]).toMatchObject({ providerStatus: 'cancel_scheduled' });
      expect(updates[0]).not.toHaveProperty('isDefault');
    });

    it('is ONE call, not one per add-on', async () => {
      // Every row shares the same providerSubscriptionId, so there is no
      // fan-out here as there is for Lemon Squeezy.
      const { adapter, posts } = makeAdapter({
        rows: structuredClone(LOADED_ROWS),
      });
      await adapter.cancel(1, true);
      expect(posts).toHaveLength(1);
    });
  });

  describe('pause', () => {
    it('pauses at the period end, not mid-cycle', async () => {
      // Someone who paused keeps what they already paid for until it runs
      // out; `immediately` would end their service for money already taken.
      const { adapter, posts } = makeAdapter({
        rows: structuredClone(LOADED_ROWS),
      });
      await adapter.pause(1);
      expect(posts[0]).toEqual({
        path: 'subscriptions/sub_paddle_1/pause',
        body: { effective_from: 'next_billing_period' },
      });
    });
  });

  describe('resume', () => {
    it('resumes immediately', async () => {
      const { adapter, posts } = makeAdapter({
        rows: structuredClone(LOADED_ROWS),
      });
      await adapter.resume(1);
      expect(posts[0]).toEqual({
        path: 'subscriptions/sub_paddle_1/resume',
        body: { effective_from: 'immediately' },
      });
    });
  });

  // ------------------------------------------- portal, invoices, profile

  describe('createPortalLink', () => {
    it('deep-links to the card form for update_payment_method', async () => {
      const { adapter } = makeAdapter({ rows: structuredClone(LOADED_ROWS) });
      await expect(
        adapter.createPortalLink(1, 'update_payment_method'),
      ).resolves.toEqual({ url: 'https://portal.paddle.test/card' });
    });

    it('opens the overview for a plain portal visit', async () => {
      const { adapter } = makeAdapter({ rows: structuredClone(LOADED_ROWS) });
      await expect(adapter.createPortalLink(1, 'portal')).resolves.toEqual({
        url: 'https://portal.paddle.test/overview',
      });
    });

    it('falls back to the overview when no card link comes back', async () => {
      // Better the portal's front door than an error on a settings page.
      const { adapter, paddle } = makeAdapter({
        rows: structuredClone(LOADED_ROWS),
      });
      (paddle.post as jest.Mock).mockResolvedValue({
        data: {
          urls: {
            general: { overview: 'https://portal.paddle.test/overview' },
            subscriptions: [{ id: 'sub_paddle_1' }],
          },
        },
      });
      await expect(
        adapter.createPortalLink(1, 'update_payment_method'),
      ).resolves.toEqual({ url: 'https://portal.paddle.test/overview' });
    });

    it('mints a session per call, never caching one', async () => {
      // Paddle: "Customer portal sessions are temporary and shouldn't be
      // cached" — the links carry a short-lived token.
      const { adapter, paddle } = makeAdapter({
        rows: structuredClone(LOADED_ROWS),
      });
      await adapter.createPortalLink(1, 'portal');
      await adapter.createPortalLink(1, 'portal');
      expect(
        (paddle.post as jest.Mock).mock.calls.filter((c: unknown[]) =>
          String(c[0]).includes('portal-sessions'),
        ),
      ).toHaveLength(2);
    });

    it('refuses when no Paddle customer is recorded', async () => {
      const rows = structuredClone(LOADED_ROWS);
      rows[0].providerCustomerId = null as never;
      const { adapter } = makeAdapter({ rows });
      await expect(adapter.createPortalLink(1, 'portal')).rejects.toThrow(
        /no Paddle customer/,
      );
    });
  });

  describe('listInvoices', () => {
    it('reads transactions for the subscription', async () => {
      const { adapter, paddle } = makeAdapter({
        rows: structuredClone(LOADED_ROWS),
      });
      await adapter.listInvoices(1, 10);
      const call = (paddle.get as jest.Mock).mock.calls
        .map((c: unknown[]) => String(c[0]))
        .find((p: string) => p.startsWith('transactions?'));
      expect(call).toContain('subscription_id=sub_paddle_1');
      expect(call).toContain('per_page=10');
    });

    it('clamps per_page to Paddle’s maximum of 30', async () => {
      // Asking for more is a 400, which would read as "invoices are broken".
      const { adapter, paddle } = makeAdapter({
        rows: structuredClone(LOADED_ROWS),
      });
      await adapter.listInvoices(1, 500);
      const call = (paddle.get as jest.Mock).mock.calls
        .map((c: unknown[]) => String(c[0]))
        .find((p: string) => p.startsWith('transactions?'));
      expect(call).toContain('per_page=30');
    });

    it('maps Paddle statuses into our invoice vocabulary', async () => {
      const { adapter, paddle } = makeAdapter({
        rows: structuredClone(LOADED_ROWS),
      });
      (paddle.get as jest.Mock).mockImplementation((path: string) => {
        if (path.startsWith('transactions?'))
          return Promise.resolve({
            data: [
              { id: 't1', status: 'completed', created_at: '2026-01-01T00:00:00Z', details: { totals: { grand_total: '2900' } }, currency_code: 'usd' },
              { id: 't2', status: 'past_due', created_at: '2026-01-02T00:00:00Z' },
              { id: 't3', status: 'canceled', created_at: '2026-01-03T00:00:00Z' },
              { id: 't4', status: 'billed', created_at: '2026-01-04T00:00:00Z' },
            ],
          });
        if (path.startsWith('subscriptions/'))
          return Promise.resolve({ data: { items: [] } });
        return Promise.resolve({ data: {} });
      });

      const out = await adapter.listInvoices(1, 10);
      expect(out.map((i) => i.status)).toEqual([
        'paid',
        'failed',
        'void',
        'pending',
      ]);
      // Minor units arrive as a STRING; a settings page that printed "2900"
      // as dollars would be out by a hundred.
      expect(out[0].amountCents).toBe(2900);
      expect(out[0].currency).toBe('USD');
    });

    it('reads a zero total rather than NaN when Paddle sends no totals', async () => {
      const { adapter, paddle } = makeAdapter({
        rows: structuredClone(LOADED_ROWS),
      });
      (paddle.get as jest.Mock).mockImplementation((path: string) =>
        path.startsWith('transactions?')
          ? Promise.resolve({
              data: [{ id: 't1', status: 'paid', created_at: '2026-01-01T00:00:00Z' }],
            })
          : Promise.resolve({ data: { items: [] } }),
      );
      const out = await adapter.listInvoices(1, 10);
      expect(out[0].amountCents).toBe(0);
    });
  });

  describe('getBillingProfile', () => {
    it('returns the contact and a NULL card', async () => {
      // Paddle does not hand card details over the API — the portal owns
      // them. A guessed last4 on a settings page reads as the wrong card
      // being charged.
      const { adapter } = makeAdapter({ rows: structuredClone(LOADED_ROWS) });
      await expect(adapter.getBillingProfile(1)).resolves.toEqual({
        card: null,
        billingDetails: {
          name: 'Owner',
          email: 'owner@example.com',
          country: null,
        },
      });
    });

    it('is empty rather than throwing when no customer is recorded', async () => {
      const rows = structuredClone(LOADED_ROWS);
      rows[0].providerCustomerId = null as never;
      const { adapter } = makeAdapter({ rows });
      await expect(adapter.getBillingProfile(1)).resolves.toEqual({
        card: null,
        billingDetails: null,
      });
    });
  });

  // ---------------------------------------------------------------- shared

  it('refuses a subscription with no provider rows at all', async () => {
    const { adapter } = makeAdapter({ rows: [] });
    await expect(adapter.cancel(1, true)).rejects.toThrow(/no provider rows/);
  });
});
