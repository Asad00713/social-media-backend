// src/billing/providers/stripe.adapter.spec.ts
import { StripeAdapter } from './stripe.adapter';
// The REAL liveness predicate every billing branch reads. Asserting the
// status STRING alone would pass for a spelling the deny-list ignores, which
// is exactly how `removed` shipped.
import { isLive } from '../services/provider-subscription.util';

/**
 * The `id` a drizzle `eq(column, value)` binds, so the update fake can land
 * its patch on the right row. Returns undefined for any other shape, which
 * the caller treats as "apply to all" — the pre-existing behaviour.
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
    /**
     * `update` APPLIES its patch to the seeded rows, it does not only record
     * it. The recording alone made the store lie to any code that read back
     * after writing — and `rehomeDefault` does exactly that: it re-reads the
     * account to find an heir, so against a non-applying fake it still saw the
     * row it had just released as holding a live default, took its
     * early-return, and wrote nothing. The test then "failed" for a defect in
     * the fake rather than in the adapter.
     *
     * The `where` is still unconstrained, so the patch lands on the row the
     * caller identified by position — sufficient here because every update in
     * this adapter is `eq(providerSubscriptions.id, <row>.id)` and the tests
     * seed rows with distinct ids.
     */
    update: jest.fn().mockReturnValue({
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
  // `rows` is the live store: the update fake mutates it, so reading it back
  // after a call shows the RESULTING STATE rather than only the patch.
  return { adapter, stripe, customers, catalogue, inserts, updates, rows };
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

  // C1, on the adapter's own termination path. Dropping the flag is only half
  // of it: `is_default` names the provider billing THE ACCOUNT, and this
  // UPDATE touches one Stripe row, so mid-cutover a live Lemon Squeezy row
  // survives untouched. Zero defaults on an account Lemon Squeezy still
  // charges makes `hasLiveBasePlan` answer false for a paying customer and
  // opens a SECOND subscription through the FREE->paid branch.
  it('hands is_default to a live LEMON SQUEEZY row on an immediate cancel', async () => {
    const { adapter, updates } = makeAdapter([
      {
        id: 1,
        itemType: 'BASE_PLAN',
        providerSubscriptionId: 'sub_1',
        provider: 'stripe',
        providerStatus: 'active',
        isDefault: true,
      },
      {
        id: 2,
        itemType: 'BASE_PLAN',
        providerSubscriptionId: 'ls_sub_1',
        provider: 'lemonsqueezy',
        providerStatus: 'active',
        isDefault: false,
      },
    ]);

    await adapter.cancel(1, false);

    // Two writes: the Stripe row released it, and the live Lemon Squeezy row
    // was handed it. The second write is the one that was missing.
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({
      providerStatus: 'canceled',
      isDefault: false,
    });
    expect(updates[1]).toMatchObject({ isDefault: true });
  });

  it('leaves the flag on Stripe for a SCHEDULED cancel, which is still billing', async () => {
    // `atPeriodEnd = true` keeps `is_default` on the Stripe row, so there is
    // no vacancy and the flag must not move to Lemon Squeezy — doing so would
    // raise 23505 against the partial unique index while Stripe still bills.
    //
    // HONEST ABOUT WHAT THIS PINS. Calling `rehomeDefault` here anyway would
    // be a no-op, because its first guard sees the still-live Stripe row
    // holding the flag and returns — verified by mutation (`if (true)` in
    // place of `if (!atPeriodEnd)` breaks nothing). So this asserts the
    // OUTCOME, which is what matters and stays true either way; the
    // `!atPeriodEnd` condition is belt-and-braces over that guard, not the
    // thing keeping the account correct.
    const { adapter, updates, rows } = makeAdapter([
      {
        id: 1,
        itemType: 'BASE_PLAN',
        providerSubscriptionId: 'sub_1',
        provider: 'stripe',
        providerStatus: 'active',
        isDefault: true,
      },
      {
        id: 2,
        itemType: 'BASE_PLAN',
        providerSubscriptionId: 'ls_sub_1',
        provider: 'lemonsqueezy',
        providerStatus: 'active',
        isDefault: false,
      },
    ]);

    await adapter.cancel(1, true);

    expect(updates).toHaveLength(1);
    expect(updates[0]).not.toHaveProperty('isDefault');
    // The outcome: Stripe still holds it, Lemon Squeezy did not take it.
    const [stripeRow, lsRow] = rows;
    expect(stripeRow.isDefault).toBe(true);
    expect(lsRow.isDefault).toBe(false);
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

/**
 * I2 — a status that reads as LIVE for a line item that is gone.
 *
 * `isLive` is a DENY-LIST and fails OPEN by design, so a status it has never
 * heard of reads as still billing. `removeAddon` wrote `removed`, which was
 * not in it, so a deleted Stripe line item went on counting as live: it fed
 * `billedQuantities`, and it was an eligible heir in `rehomeDefault`'s search,
 * which would let a removed add-on hold `is_default` and make an unbilled
 * account read as paying.
 */
describe('StripeAdapter.removeAddon', () => {
  const ROWS = [
    {
      id: 9,
      itemType: 'EXTRA_CHANNEL',
      providerItemId: 'si_addon',
      providerSubscriptionId: 'sub_1',
      provider: 'stripe',
      isDefault: false,
    },
  ];

  it('writes a status the live-check actually recognises as terminal', async () => {
    const { adapter, updates } = makeAdapter(ROWS);

    await adapter.removeAddon(1, 'EXTRA_CHANNEL');

    expect(updates).toHaveLength(1);
    // `canceled`, the vocabulary `endStripeProviderRows` already uses for the
    // same fact. One spelling per fact is what stops the next status drifting
    // out of the deny-list the same way.
    expect(updates[0].providerStatus).toBe('canceled');
  });

  it('leaves a removed add-on reading as NOT live', async () => {
    // The assertion that matters — the real predicate, not the string. A test
    // pinning only the literal passes for any spelling, including one the
    // deny-list has never heard of.
    const { adapter, updates } = makeAdapter(ROWS);

    await adapter.removeAddon(1, 'EXTRA_CHANNEL');

    expect(isLive({ ...ROWS[0], ...updates[0] } as never)).toBe(false);
  });
});
