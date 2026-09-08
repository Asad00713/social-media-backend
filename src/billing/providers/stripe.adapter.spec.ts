// src/billing/providers/stripe.adapter.spec.ts
import { StripeAdapter } from './stripe.adapter';

function makeAdapter(rows: Record<string, unknown>[] = []) {
  /** Every row payload handed to `db.insert(...).values(...)`, in order. */
  const inserts: Record<string, unknown>[] = [];
  /** Every payload handed to `db.update(...).set(...)`, in order. */
  const updates: Record<string, unknown>[] = [];
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(rows),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn((v: Record<string, unknown>) => {
        updates.push(v);
        return { where: jest.fn().mockResolvedValue(undefined) };
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn((v: Record<string, unknown>) => {
        inserts.push(v);
        return { onConflictDoUpdate: jest.fn().mockResolvedValue(undefined) };
      }),
    }),
  };
  const stripe = {
    addSubscriptionItem: jest.fn().mockResolvedValue({ id: 'si_new' }),
    updateSubscriptionItem: jest.fn().mockResolvedValue({ id: 'si_new' }),
    updateSubscription: jest.fn().mockResolvedValue({ id: 'sub_1' }),
    deleteSubscriptionItem: jest.fn().mockResolvedValue(undefined),
    pauseSubscription: jest.fn().mockResolvedValue(undefined),
    resumeSubscription: jest.fn().mockResolvedValue(undefined),
    cancelSubscription: jest.fn().mockResolvedValue(undefined),
    createCheckoutSession: jest
      .fn()
      .mockResolvedValue({ url: 'https://stripe.test/c/1' }),
  };
  const customers = {
    getOrCreateStripeCustomer: jest
      .fn()
      .mockResolvedValue({ stripeCustomerId: 'cus_1' }),
  };
  const catalogue = { resolveRef: jest.fn().mockResolvedValue('price_1') };
  const adapter = new StripeAdapter(
    db as never,
    stripe as never,
    customers as never,
    catalogue as never,
  );
  return { adapter, stripe, customers, catalogue, inserts, updates };
}

describe('StripeAdapter', () => {
  it('identifies itself as stripe', () => {
    expect(makeAdapter().adapter.name).toBe('stripe');
  });

  // Layer 1 has to actually FIRE, or it is a guard that guards nothing. If the
  // registry ever hands this adapter a Lemon Squeezy subscription — a routing
  // bug — it must refuse rather than quietly charging the wrong provider.
  it('refuses to act on a subscription billed by another provider', async () => {
    const { adapter } = makeAdapter([
      {
        itemType: 'BASE_PLAN',
        providerSubscriptionId: 'sub_1',
        provider: 'lemonsqueezy',
        isDefault: true,
      },
    ]);
    await expect(adapter.cancel(1, true)).rejects.toThrow(/lemonsqueezy/i);
  });

  // Stripe can add an item and invoice server-side, so nothing is redirected.
  it('completes an add-on purchase without a checkout redirect', async () => {
    const { adapter } = makeAdapter([
      {
        itemType: 'BASE_PLAN',
        providerSubscriptionId: 'sub_1',
        provider: 'stripe',
      },
    ]);
    const result = await adapter.purchaseAddon(1, 'EXTRA_CHANNEL', 3);
    expect(result).toEqual({ status: 'completed', quantity: 3 });
  });

  it('cancels through the existing StripeService', async () => {
    const { adapter, stripe } = makeAdapter([
      {
        itemType: 'BASE_PLAN',
        providerSubscriptionId: 'sub_1',
        provider: 'stripe',
      },
    ]);
    await adapter.cancel(1, true);
    expect(stripe.cancelSubscription).toHaveBeenCalledWith('sub_1', true);
  });

  // The is_default hazard this fix closes: an immediate cancel is genuine
  // termination, the same shape endStripeProviderRows exists for, and must
  // free the single slot provider_subscriptions_one_default_idx allows.
  // Before the fix the row was left isDefault:true after `providerStatus:
  // 'canceled'` was written, squatting the slot until the
  // subscription.deleted webhook eventually self-healed it.
  it('drops is_default on an immediate cancel, freeing the slot for another provider', async () => {
    const { adapter, updates } = makeAdapter([
      {
        itemType: 'BASE_PLAN',
        providerSubscriptionId: 'sub_1',
        provider: 'stripe',
        isDefault: true,
      },
    ]);

    await adapter.cancel(1, false);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      providerStatus: 'canceled',
      isDefault: false,
    });
  });

  // The counterpart: a scheduled (at-period-end) cancel is still billing
  // until the period ends, so it must NOT drop is_default the way an
  // immediate cancel does — the account is still the default provider until
  // then.
  it('keeps is_default on a scheduled cancel, since billing continues to period end', async () => {
    const { adapter, updates } = makeAdapter([
      {
        itemType: 'BASE_PLAN',
        providerSubscriptionId: 'sub_1',
        provider: 'stripe',
        isDefault: true,
      },
    ]);

    await adapter.cancel(1, true);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ providerStatus: 'cancel_scheduled' });
    expect(updates[0]).not.toHaveProperty('isDefault');
  });

  // The line-62 hazard: this call used to run before the plan was even read,
  // creating a Stripe customer for accounts that would never use Stripe. It
  // now lives inside the adapter, so it cannot run for anyone else.
  it('creates the Stripe customer inside the adapter, not the caller', async () => {
    const { adapter, customers } = makeAdapter();
    await adapter.createCheckout('user-1', 'PRO', 'ws-1');
    expect(customers.getOrCreateStripeCustomer).toHaveBeenCalledWith('user-1');
  });

  it('returns the Stripe checkout url', async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.createCheckout('user-1', 'PRO', 'ws-1')).resolves.toEqual(
      { url: 'https://stripe.test/c/1' },
    );
  });

  // Regression pin for the line-115 hazard: `updateSubscriptionItem` has no
  // `price` field on Stripe's API — it can only change `quantity`. Changing
  // plan means changing which price the item points at, which is a
  // subscription-level call (`items: [{ id, price }]`). Without this test the
  // adapter could write the new plan into our DB while Stripe kept billing
  // the old one, silently.
  it('sends the new price id to Stripe when changing plan', async () => {
    const { adapter, stripe, catalogue } = makeAdapter([
      {
        itemType: 'BASE_PLAN',
        providerSubscriptionId: 'sub_1',
        providerItemId: 'si_base',
        provider: 'stripe',
      },
    ]);
    catalogue.resolveRef.mockResolvedValue('price_pro');

    await adapter.changePlan(1, 'PRO');

    expect(stripe.updateSubscription).toHaveBeenCalledWith('sub_1', {
      items: [{ id: 'si_base', price: 'price_pro' }],
      proration_behavior: 'none',
    });
  });

  // The migration-window hazard: during the LS -> Stripe cutover an account
  // can hold a row from EACH provider for the same itemType (this is by
  // design — see billing.schema.ts around the unique-per-(subscription,
  // provider, itemType) index). The Task 6 guard only inspects the isDefault
  // row, so it does not stop a later itemType lookup from picking the WRONG
  // provider's row. This pins that the Stripe row is the one selected.
  it('picks the Stripe row, not a same-itemType Lemon Squeezy row, during migration overlap', async () => {
    const { adapter, stripe } = makeAdapter([
      {
        itemType: 'BASE_PLAN',
        providerSubscriptionId: 'ls_sub_1',
        provider: 'lemonsqueezy',
        isDefault: false,
      },
      {
        itemType: 'BASE_PLAN',
        providerSubscriptionId: 'sub_1',
        provider: 'stripe',
        isDefault: true,
      },
    ]);

    await adapter.cancel(1, true);

    expect(stripe.cancelSubscription).toHaveBeenCalledWith('sub_1', true);
  });

  /**
   * `is_default` marks the account's default PROVIDER, and 0032 enforces that
   * with a partial unique index — one true row per subscription. This insert
   * used to set it unconditionally, so an account that already had one (every
   * Stripe account, whose BASE_PLAN row carries it) hit a 23505 unique
   * violation AFTER `addSubscriptionItem` had already put the billable line on
   * the subscription: charged, 500'd, and no bookkeeping row written.
   *
   * It was also wrong when it landed — `pickDefaultProvider` returns whichever
   * row holds the flag, so the "scoped to the default provider" invariant that
   * `findItem` and `hasLiveBasePlan` rest on would depend on insert order.
   */
  it('does not claim the default-provider flag on an add-on row', async () => {
    const { adapter, inserts } = makeAdapter([
      {
        itemType: 'BASE_PLAN',
        providerSubscriptionId: 'sub_1',
        provider: 'stripe',
        isDefault: true,
      },
    ]);

    await adapter.purchaseAddon(1, 'EXTRA_CHANNEL', 3);

    expect(inserts).toHaveLength(1);
    expect(inserts[0].itemType).toBe('EXTRA_CHANNEL');
    expect(inserts[0].isDefault).toBe(false);
  });
});
