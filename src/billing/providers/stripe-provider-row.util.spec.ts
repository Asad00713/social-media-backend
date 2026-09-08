/**
 * The writer that was missing.
 *
 * Migration 0032 created `provider_subscriptions`, six files were changed to
 * READ from it, and nothing was ever changed to WRITE the BASE_PLAN row — the
 * only INSERT in `src/` lived inside `StripeAdapter.purchaseAddon` and writes
 * add-on item types. So the table that decides "is this account being billed"
 * was empty for the entire paying population.
 *
 * ts-jest is transpile-only here, so every assertion below is on a runtime
 * value rather than a type.
 */

const mockDb = {
  insert: jest.fn(),
  update: jest.fn(),
};

jest.mock('../../drizzle/db', () => ({ db: mockDb }));

import {
  writeStripeBasePlanRow,
  expireStripeProviderRows,
} from './stripe-provider-row.util';

/* The fakes stand in for drizzle's fluent builders; `any` is confined to them. */
/* eslint-disable @typescript-eslint/no-unsafe-return */

let inserted: Record<string, unknown>[];
let conflictSets: Record<string, unknown>[];
let updated: Record<string, unknown>[];
let insertShouldThrow: Error | null;

beforeEach(() => {
  jest.clearAllMocks();
  inserted = [];
  conflictSets = [];
  updated = [];
  insertShouldThrow = null;

  mockDb.insert.mockImplementation(() => ({
    values: (v: Record<string, unknown>) => {
      inserted.push(v);
      return {
        onConflictDoUpdate: (arg: { set: Record<string, unknown> }) => {
          conflictSets.push(arg.set);
          return insertShouldThrow
            ? Promise.reject(insertShouldThrow)
            : Promise.resolve(undefined);
        },
      };
    },
  }));

  mockDb.update.mockImplementation(() => {
    const chain: any = {
      set: (v: Record<string, unknown>) => {
        updated.push(v);
        return chain;
      },
      where: () => chain,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(undefined).then(resolve),
    };
    return chain;
  });
});

function stripeSub(over: Record<string, unknown> = {}) {
  return {
    id: 'sub_live',
    status: 'active',
    cancel_at_period_end: false,
    items: {
      data: [
        {
          id: 'si_base',
          price: { id: 'price_pro' },
          current_period_end: 1_800_000_000,
        },
      ],
    },
    ...over,
  } as never;
}

describe('writeStripeBasePlanRow', () => {
  it('writes the BASE_PLAN row that every paid/unpaid branch reads', async () => {
    await writeStripeBasePlanRow({
      subscriptionId: 42,
      stripeSubscription: stripeSub(),
      stripeCustomerId: 'cus_live',
      unitPriceCents: 20000,
    });

    expect(inserted).toHaveLength(1);
    const row = inserted[0];
    expect(row.subscriptionId).toBe(42);
    expect(row.provider).toBe('stripe');
    // Without exactly this value `hasLiveBasePlan` finds nothing and the
    // account reads as unbilled.
    expect(row.itemType).toBe('BASE_PLAN');
    expect(row.providerSubscriptionId).toBe('sub_live');
    expect(row.providerCustomerId).toBe('cus_live');
    expect(row.providerItemId).toBe('si_base');
    expect(row.providerPriceId).toBe('price_pro');
    expect(row.providerStatus).toBe('active');
  });

  it('claims the default-provider flag on insert, since Stripe is billing', async () => {
    await writeStripeBasePlanRow({
      subscriptionId: 42,
      stripeSubscription: stripeSub(),
      stripeCustomerId: 'cus_live',
    });

    expect(inserted[0].isDefault).toBe(true);
  });

  it('never moves the default-provider flag on a redelivered webhook', async () => {
    // Stripe redelivers `checkout.session.completed`. During the LS -> Stripe
    // window the flag says which provider currently bills the account, and a
    // redelivery must not silently move it — 0032's partial unique index
    // permits one true row per subscription, so flipping it could also 23505.
    await writeStripeBasePlanRow({
      subscriptionId: 42,
      stripeSubscription: stripeSub(),
      stripeCustomerId: 'cus_live',
    });

    expect(conflictSets).toHaveLength(1);
    expect('isDefault' in conflictSets[0]).toBe(false);
  });

  it('treats the period end as a RENEWAL, not an expiry, for a healthy subscription', async () => {
    // `isLive()` reads `endsAt`. Writing a renewal date into it would make
    // every healthy subscriber read as expired the moment their period rolled
    // over — the billing-after-cancel bug, rebuilt from the other direction.
    await writeStripeBasePlanRow({
      subscriptionId: 42,
      stripeSubscription: stripeSub(),
      stripeCustomerId: 'cus_live',
    });

    expect(inserted[0].endsAt).toBeNull();
    expect(inserted[0].renewsAt).toBeInstanceOf(Date);
  });

  it('records a genuine end date once the subscription is set to cancel', async () => {
    await writeStripeBasePlanRow({
      subscriptionId: 42,
      stripeSubscription: stripeSub({ cancel_at_period_end: true }),
      stripeCustomerId: 'cus_live',
    });

    expect(inserted[0].endsAt).toBeInstanceOf(Date);
    expect(inserted[0].renewsAt).toBeNull();
  });

  it('swallows a write failure instead of failing an already-charged request', async () => {
    // It runs after the customer has been charged and after `subscriptions`
    // has been written. Throwing here would tell the caller the subscription
    // did not happen when it demonstrably did.
    insertShouldThrow = new Error('deadlock detected');

    await expect(
      writeStripeBasePlanRow({
        subscriptionId: 42,
        stripeSubscription: stripeSub(),
        stripeCustomerId: 'cus_live',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('expireStripeProviderRows', () => {
  it('marks the rows expired rather than deleting the record', async () => {
    await expireStripeProviderRows(42);

    expect(updated).toHaveLength(1);
    // `isLive()` reads `expired` as not billing, which is what routes a stale
    // account to Checkout instead of back to a dead Stripe id.
    expect(updated[0].providerStatus).toBe('expired');
  });
});
