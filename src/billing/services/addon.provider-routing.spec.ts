/**
 * Add-on purchase, for an account that is NOT on Stripe.
 *
 * Two things this pins, both of which bite only a Lemon Squeezy customer and
 * only AFTER their card has been charged:
 *
 *  1. The bookkeeping insert must not carry a null `stripe_price_id`.
 *     `addon_pricing.stripe_price_id` is nullable, `subscription_items
 *     .stripe_price_id` is NOT NULL, and the `as NewSubscriptionItem` cast on
 *     the insert hides the mismatch from tsc. A Lemon Squeezy add-on has no
 *     Stripe price, so the uncoerced value is null — the provider takes the
 *     money, then Postgres rejects the row and the request 500s.
 *
 *  2. A `checkout_required` result must NOT be treated as a completed
 *     purchase: no limits granted, no bookkeeping row, and the url returned so
 *     the caller can redirect.
 *
 * ts-jest is transpile-only here, so every assertion is on a runtime value.
 */

const mockDb = {
  select: jest.fn(),
  update: jest.fn(),
  insert: jest.fn(),
  delete: jest.fn(),
};

jest.mock('../../drizzle/db', () => ({ db: mockDb }));

import { AddonService } from './addon.service';

/* The fakes below stand in for drizzle's fluent builders, whose chain types are
   not expressible here — `any` is deliberate and confined to the fakes. */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

let selectResults: unknown[][];

/** Every object handed to `.values()` on an insert, in order. */
let insertedValues: any[];

function makeSelectChain(): any {
  const rows = selectResults.shift() ?? [];
  const chain: any = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve),
  };
  return chain;
}

function makeInsertChain(): any {
  const chain: any = {
    values: (v: unknown) => {
      insertedValues.push(v);
      return chain;
    },
    set: () => chain,
    where: () => chain,
    onConflictDoUpdate: () => chain,
    returning: () => Promise.resolve([{ id: 99 }]),
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve([{ id: 99 }]).then(resolve),
  };
  return chain;
}

const WORKSPACE_ROW = { id: 'ws-1', ownerId: 'user-1' };

/** Lemon Squeezy account: stripeSubscriptionId is NULL. */
const LS_SUBSCRIPTION = {
  id: 42,
  userId: 'user-1',
  planCode: 'PRO',
  status: 'active',
  stripeCustomerId: null,
  stripeSubscriptionId: null,
};

/** A Lemon Squeezy catalogue row has NO Stripe price. That is the hazard. */
const LS_ADDON_PRICING = {
  planCode: 'PRO',
  addonType: 'EXTRA_CHANNEL',
  pricePerUnitCents: 500,
  stripePriceId: null,
  minQuantity: 1,
  maxQuantity: 50,
  unitsPerQuantity: 1,
  isActive: true,
};

const LS_PROVIDER_ROWS = [
  {
    id: 1,
    subscriptionId: 42,
    provider: 'lemonsqueezy',
    itemType: 'EXTRA_CHANNEL',
    providerSubscriptionId: 'ls-sub-2',
    providerItemId: 'ls-item-2',
    providerStatus: 'active',
    endsAt: null,
    isDefault: true,
  },
];

interface Harness {
  service: AddonService;
  adapter: { name: string; purchaseAddon: jest.Mock };
}

function makeService(purchaseResult: unknown): Harness {
  const adapter = {
    name: 'lemonsqueezy',
    purchaseAddon: jest.fn().mockResolvedValue(purchaseResult),
    changeAddonQuantity: jest.fn().mockResolvedValue(undefined),
    removeAddon: jest.fn().mockResolvedValue(undefined),
  };

  const providers = {
    adapterForSubscription: jest.fn().mockResolvedValue(adapter),
  };

  const usageService = {
    getWorkspaceUsage: jest.fn().mockResolvedValue({
      channelsLimit: 13,
      membersLimit: 5,
      aiTokensLimit: 1000,
    }),
  };

  const lookup = {
    getPrimaryWorkspaceId: jest.fn().mockResolvedValue('ws-1'),
    applyLimitsToAllWorkspaces: jest.fn().mockResolvedValue(undefined),
    getAddonQuantities: jest.fn().mockResolvedValue({}),
  };

  const stripeService = { getSubscription: jest.fn() };

  const service = new AddonService(
    stripeService as never,
    usageService as never,
    lookup as never,
    providers as never,
  );

  // The usage fan-out is exercised by its own suite; stub it so these tests
  // stay on the purchase outcome.
  jest
    .spyOn(service as never, 'updateUsageLimitsForAddon')
    .mockResolvedValue(undefined as never);

  return { service, adapter };
}

beforeEach(() => {
  jest.clearAllMocks();
  selectResults = [];
  insertedValues = [];
  mockDb.select.mockImplementation(() => makeSelectChain());
  mockDb.update.mockImplementation(() => makeInsertChain());
  mockDb.insert.mockImplementation(() => makeInsertChain());
  mockDb.delete.mockImplementation(() => makeInsertChain());
});

/**
 * @param existingItem the `subscription_items` row the account already holds,
 *   or `[]` for a first purchase.
 * @param providerRows what `provider_subscriptions` holds. The gap between
 *   these two is the whole of I1 — see the tests below.
 */
function lemonSqueezyPurchaseQueries(
  existingItem: unknown[] = [],
  providerRows: unknown[] = LS_PROVIDER_ROWS,
) {
  selectResults = [
    [WORKSPACE_ROW], // ownership
    [LS_SUBSCRIPTION], // the account's subscription
    [LS_ADDON_PRICING], // addon_pricing — stripePriceId is NULL
    existingItem, // the existing subscription_items row, if any
    providerRows, // provider_subscriptions, BEFORE the purchase (I1)
    providerRows, // provider_subscriptions again, for the item id
  ];
}

describe('purchaseAddon on a Lemon Squeezy account', () => {
  it('never writes a null stripe_price_id into the NOT NULL bookkeeping column', async () => {
    const { service } = makeService({ status: 'completed', quantity: 3 });
    lemonSqueezyPurchaseQueries();

    await service.purchaseAddon({
      workspaceId: 'ws-1',
      userId: 'user-1',
      addonType: 'EXTRA_CHANNEL',
      quantity: 3,
    });

    const itemInsert = insertedValues.find(
      (v) => v && v.itemType === 'EXTRA_CHANNEL' && 'stripePriceId' in v,
    );
    expect(itemInsert).toBeDefined();
    // The bug: this was `null`, and Postgres rejected the row AFTER Lemon
    // Squeezy had already charged the customer.
    expect(itemInsert.stripePriceId).toBe('');
    expect(itemInsert.stripePriceId).not.toBeNull();
  });

  it('routes the purchase to the account’s own adapter', async () => {
    const { service, adapter } = makeService({
      status: 'completed',
      quantity: 3,
    });
    lemonSqueezyPurchaseQueries();

    await service.purchaseAddon({
      workspaceId: 'ws-1',
      userId: 'user-1',
      addonType: 'EXTRA_CHANNEL',
      quantity: 3,
    });

    expect(adapter.purchaseAddon).toHaveBeenCalledWith(42, 'EXTRA_CHANNEL', 3);
  });

  it('returns the checkout url and grants nothing when the provider needs one', async () => {
    const { service } = makeService({
      status: 'checkout_required',
      url: 'https://store.lemonsqueezy.com/checkout/abc',
    });
    lemonSqueezyPurchaseQueries();

    const result = await service.purchaseAddon({
      workspaceId: 'ws-1',
      userId: 'user-1',
      addonType: 'EXTRA_CHANNEL',
      quantity: 3,
    });

    expect(result.status).toBe('checkout_required');
    expect(result).toMatchObject({
      checkoutUrl: 'https://store.lemonsqueezy.com/checkout/abc',
    });

    // Nothing has been paid for yet, so nothing may be recorded or granted.
    const itemInsert = insertedValues.find(
      (v) => v && 'stripePriceId' in v && v.itemType === 'EXTRA_CHANNEL',
    );
    expect(itemInsert).toBeUndefined();
  });
});

/**
 * I1 — what NUMBER reaches the provider.
 *
 * `purchaseAddon` is ABSOLUTE when the provider already holds a record of this
 * add-on and an INCREMENT when it does not, because a Lemon Squeezy checkout
 * opens a brand-new subscription that bills for exactly the figure in it,
 * alongside whatever is already running. The service sent `existing + quantity`
 * unconditionally, which is right for the first case and bills twice in the
 * second.
 */
describe('the quantity sent to the provider', () => {
  const EXISTING_ITEM = [{ id: 7, quantity: 2, itemType: 'EXTRA_CHANNEL' }];

  it('sends the cumulative TOTAL when the provider already holds the add-on', async () => {
    // Absolute semantics: Lemon Squeezy PATCHes the subscription item's
    // quantity and Stripe sets the line item's, so the new total is the
    // correct figure and anything less would silently REDUCE what the customer
    // holds.
    const { service, adapter } = makeService({
      status: 'completed',
      quantity: 5,
    });
    lemonSqueezyPurchaseQueries(EXISTING_ITEM, LS_PROVIDER_ROWS);

    await service.purchaseAddon({
      workspaceId: 'ws-1',
      userId: 'user-1',
      addonType: 'EXTRA_CHANNEL',
      quantity: 3,
    });

    // 2 already held + 3 more.
    expect(adapter.purchaseAddon).toHaveBeenCalledWith(42, 'EXTRA_CHANNEL', 5);
  });

  it('sends only the INCREMENT when the provider holds no row for it', async () => {
    // THE DEFECT. `subscription_items` says the customer holds 2, but
    // `provider_subscriptions` has no row — reachable, because the Lemon
    // Squeezy add-on `subscription_created` webhook is what writes that row,
    // and a first checkout whose `custom_data` carried no resolvable account
    // writes neither it nor a redelivery.
    //
    // `LemonSqueezyAdapter.purchaseAddon` therefore misses and opens a FRESH
    // checkout. Sent the cumulative 5, that checkout creates a second
    // subscription billing for 5 while the original add-on subscription keeps
    // billing for 2 — the customer pays for 7 and receives 5.
    const { service, adapter } = makeService({
      status: 'checkout_required',
      url: 'https://store.lemonsqueezy.com/checkout/abc',
    });
    lemonSqueezyPurchaseQueries(EXISTING_ITEM, []);

    const result = await service.purchaseAddon({
      workspaceId: 'ws-1',
      userId: 'user-1',
      addonType: 'EXTRA_CHANNEL',
      quantity: 3,
    });

    // 3, not 5: the customer is already being charged for the other 2.
    expect(adapter.purchaseAddon).toHaveBeenCalledWith(42, 'EXTRA_CHANNEL', 3);
    // And the caller is told what this checkout actually bills for.
    expect(result).toMatchObject({ quantity: 3 });
  });

  it('still enforces the cap against the TRUE total, not the increment', async () => {
    // The increment must not become a way past `maxQuantity`. The cap is
    // checked on `existing + quantity` regardless of which figure the provider
    // is sent.
    const { service, adapter } = makeService({
      status: 'checkout_required',
      url: 'https://store.lemonsqueezy.com/checkout/abc',
    });
    lemonSqueezyPurchaseQueries(
      [{ id: 7, quantity: 49, itemType: 'EXTRA_CHANNEL' }],
      [],
    );

    await expect(
      service.purchaseAddon({
        workspaceId: 'ws-1',
        userId: 'user-1',
        addonType: 'EXTRA_CHANNEL',
        quantity: 5,
      }),
    ).rejects.toThrow(/Maximum total/);

    // Rejected BEFORE the provider was asked for anything.
    expect(adapter.purchaseAddon).not.toHaveBeenCalled();
  });
});
