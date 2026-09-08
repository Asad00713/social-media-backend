import {
  pickDefaultProvider,
  rowsForProvider,
  findItem,
  hasLegacyProvider,
  isLive,
  billedQuantities,
  hasLiveBasePlan,
} from './provider-subscription.util';
import { ProviderSubscription } from '../../drizzle/schema';

/**
 * These assert RUNTIME behaviour, not types — ts-jest is transpile-only in
 * this repo, so a type-only assertion would prove nothing.
 */

let nextId = 1;

function row(over: Partial<ProviderSubscription> = {}): ProviderSubscription {
  return {
    id: nextId++,
    subscriptionId: 1,
    provider: 'lemonsqueezy',
    itemType: 'BASE_PLAN',
    providerSubscriptionId: 'ls-1',
    providerCustomerId: 'cus-1',
    providerItemId: 'item-1',
    providerPriceId: 'variant-1',
    providerQuantity: 1,
    unitPriceCents: 20000,
    providerStatus: 'active',
    endsAt: null,
    renewsAt: null,
    isDefault: false,
    data: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as ProviderSubscription;
}

/** The shape Lemon Squeezy forces: five subscriptions for one account. */
function lemonSqueezyAccount(): ProviderSubscription[] {
  return [
    row({ itemType: 'BASE_PLAN', isDefault: true }),
    row({ itemType: 'EXTRA_CHANNEL', providerQuantity: 3 }),
    row({ itemType: 'EXTRA_MEMBER', providerQuantity: 2 }),
    row({ itemType: 'EXTRA_WORKSPACE', providerQuantity: 1 }),
    row({ itemType: 'EXTRA_AI_TOKENS', providerQuantity: 5 }),
  ];
}

describe('pickDefaultProvider', () => {
  it('returns the provider currently billing the account', () => {
    expect(pickDefaultProvider(lemonSqueezyAccount())).toBe('lemonsqueezy');
  });

  it('returns null when nothing is marked default', () => {
    expect(pickDefaultProvider([row(), row()])).toBeNull();
  });

  it('returns null for an account with no provider records', () => {
    expect(pickDefaultProvider([])).toBeNull();
  });
});

describe('findItem', () => {
  it('finds one add-on among the five rows Lemon Squeezy needs', () => {
    const found = findItem(lemonSqueezyAccount(), 'EXTRA_CHANNEL');
    expect(found?.providerQuantity).toBe(3);
  });

  it('returns null for an add-on the account never bought', () => {
    const rows = [row({ itemType: 'BASE_PLAN', isDefault: true })];
    expect(findItem(rows, 'EXTRA_MEMBER')).toBeNull();
  });

  // The migration hazard: during the cutover window an account holds a
  // BASE_PLAN at BOTH providers. A lookup ignoring is_default would return
  // whichever row came back first.
  it('ignores the old provider once the default has moved', () => {
    const rows = [
      row({ provider: 'lemonsqueezy', providerSubscriptionId: 'ls-old' }),
      row({
        provider: 'stripe',
        providerSubscriptionId: 'sub_new',
        isDefault: true,
      }),
    ];
    expect(findItem(rows, 'BASE_PLAN')?.providerSubscriptionId).toBe('sub_new');
  });

  it('is not fooled by the order rows arrive in', () => {
    const rows = [
      row({
        provider: 'stripe',
        providerSubscriptionId: 'sub_new',
        isDefault: true,
      }),
      row({ provider: 'lemonsqueezy', providerSubscriptionId: 'ls-old' }),
    ];
    expect(findItem(rows, 'BASE_PLAN')?.providerSubscriptionId).toBe('sub_new');
  });
});

describe('isLive', () => {
  it('treats an active record as live', () => {
    expect(isLive(row({ providerStatus: 'active' }))).toBe(true);
  });

  it('treats expired as revoked — the only Lemon Squeezy status that is', () => {
    expect(isLive(row({ providerStatus: 'expired' }))).toBe(false);
  });

  // The trap: Lemon Squeezy's `cancelled` means the customer KEEPS access
  // until ends_at. Reading it as "access over" cuts off paying customers.
  it('keeps a Lemon Squeezy `cancelled` record live until ends_at passes', () => {
    const future = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    expect(isLive(row({ providerStatus: 'cancelled', endsAt: future }))).toBe(
      true,
    );
  });

  it('drops a `cancelled` record once ends_at is in the past', () => {
    const past = new Date(Date.now() - 24 * 3600 * 1000);
    expect(isLive(row({ providerStatus: 'cancelled', endsAt: past }))).toBe(
      false,
    );
  });

  it('keeps a `cancelled` record live when no end date is known', () => {
    expect(isLive(row({ providerStatus: 'cancelled', endsAt: null }))).toBe(
      true,
    );
  });

  it('treats past_due as live — dunning is still trying, access continues', () => {
    expect(isLive(row({ providerStatus: 'past_due' }))).toBe(true);
  });

  it('treats an unknown status as live rather than locking the customer out', () => {
    expect(isLive(row({ providerStatus: 'on_trial' }))).toBe(true);
    expect(isLive(row({ providerStatus: null }))).toBe(true);
  });
});

describe('hasLegacyProvider', () => {
  it('is false for an account that has only ever used one provider', () => {
    expect(hasLegacyProvider(lemonSqueezyAccount())).toBe(false);
  });

  // Mid-migration: moved to Stripe, but the paid Lemon Squeezy period runs on.
  it('is true while the old provider still has a live record', () => {
    const future = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const rows = [
      row({
        provider: 'lemonsqueezy',
        providerStatus: 'cancelled',
        endsAt: future,
      }),
      row({ provider: 'stripe', isDefault: true }),
    ];
    expect(hasLegacyProvider(rows)).toBe(true);
  });

  it('is false once the old provider has expired', () => {
    const rows = [
      row({ provider: 'lemonsqueezy', providerStatus: 'expired' }),
      row({ provider: 'stripe', isDefault: true }),
    ];
    expect(hasLegacyProvider(rows)).toBe(false);
  });
});

describe('billedQuantities', () => {
  it('reports what the default provider is charging for, excluding the base plan', () => {
    expect(billedQuantities(lemonSqueezyAccount())).toEqual({
      EXTRA_CHANNEL: 3,
      EXTRA_MEMBER: 2,
      EXTRA_WORKSPACE: 1,
      EXTRA_AI_TOKENS: 5,
    });
  });

  // Otherwise a customer mid-migration would be billed twice over in our own
  // reporting: once at the old provider and once at the new.
  it('counts only the default provider, never the lapsing one', () => {
    const future = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const rows = [
      row({ provider: 'stripe', itemType: 'BASE_PLAN', isDefault: true }),
      row({
        provider: 'stripe',
        itemType: 'EXTRA_CHANNEL',
        providerQuantity: 2,
      }),
      row({
        provider: 'lemonsqueezy',
        itemType: 'EXTRA_CHANNEL',
        providerQuantity: 9,
        providerStatus: 'cancelled',
        endsAt: future,
      }),
    ];
    expect(billedQuantities(rows)).toEqual({ EXTRA_CHANNEL: 2 });
  });

  it('drops add-ons that are no longer live', () => {
    const rows = [
      row({ itemType: 'BASE_PLAN', isDefault: true }),
      row({
        itemType: 'EXTRA_CHANNEL',
        providerQuantity: 3,
        providerStatus: 'expired',
      }),
    ];
    expect(billedQuantities(rows)).toEqual({});
  });

  it('returns nothing when no provider is default', () => {
    expect(billedQuantities([row({ itemType: 'EXTRA_CHANNEL' })])).toEqual({});
  });
});

describe('rowsForProvider', () => {
  it('selects one provider’s records so the other can be cancelled cleanly', () => {
    const rows = [
      row({ provider: 'lemonsqueezy', itemType: 'BASE_PLAN' }),
      row({ provider: 'lemonsqueezy', itemType: 'EXTRA_CHANNEL' }),
      row({ provider: 'stripe', itemType: 'BASE_PLAN', isDefault: true }),
    ];
    expect(rowsForProvider(rows, 'lemonsqueezy')).toHaveLength(2);
    expect(rowsForProvider(rows, 'stripe')).toHaveLength(1);
  });
});

describe('hasLiveBasePlan', () => {
  it('is true for a Lemon Squeezy account, whose stripe_subscription_id is NULL', () => {
    // The whole point. Every branch that used to ask
    // `if (sub.stripeSubscriptionId)` read FALSE here and concluded nothing
    // was being billed, while Lemon Squeezy carried on charging.
    expect(hasLiveBasePlan(lemonSqueezyAccount())).toBe(true);
  });

  it('is true for a Stripe account', () => {
    expect(
      hasLiveBasePlan([
        row({ provider: 'stripe', itemType: 'BASE_PLAN', isDefault: true }),
      ]),
    ).toBe(true);
  });

  it('is false for an account with no provider records at all', () => {
    expect(hasLiveBasePlan([])).toBe(false);
  });

  it('is false when the account holds only add-ons and no base plan', () => {
    expect(
      hasLiveBasePlan([row({ itemType: 'EXTRA_CHANNEL', isDefault: true })]),
    ).toBe(false);
  });

  it('is false once the base plan has expired', () => {
    expect(
      hasLiveBasePlan([
        row({
          itemType: 'BASE_PLAN',
          isDefault: true,
          providerStatus: 'expired',
        }),
      ]),
    ).toBe(false);
  });

  it('stays true for a Lemon Squeezy base plan cancelled but not yet ended', () => {
    // LS `cancelled` keeps access (and billing to date) until `ends_at`, so a
    // downgrade must still cancel it at the provider rather than assume it is
    // already gone.
    expect(
      hasLiveBasePlan([
        row({
          itemType: 'BASE_PLAN',
          isDefault: true,
          providerStatus: 'cancelled',
          endsAt: new Date(Date.now() + 86_400_000),
        }),
      ]),
    ).toBe(true);
  });

  it('is false for a base plan belonging to a non-default provider only', () => {
    // Mid-migration the old provider's row lingers; it must not be mistaken
    // for the account's current billing.
    expect(
      hasLiveBasePlan([
        row({ provider: 'stripe', itemType: 'BASE_PLAN', isDefault: false }),
      ]),
    ).toBe(false);
  });
});

/**
 * The legacy fallback.
 *
 * `provider_subscriptions` was created by migration 0032 and read by six
 * files, and nothing ever wrote a BASE_PLAN row into it. So every account that
 * predates the provider table — which today is the entire paying population —
 * has `stripe_subscription_id` set and ZERO provider rows, and
 * `hasLiveBasePlan` returned false for all of them: `downgradeToFree` stripped
 * the plan without cancelling (Stripe billed on forever) and `changePlan`
 * created a second live subscription.
 *
 * Migration 0034 backfills them and `writeStripeBasePlanRow` writes them from
 * now on, so in a healthy database this branch never fires. It exists because
 * "the bookkeeping row is missing" and "this customer is not being billed" are
 * different facts, and only one of them is safe to guess wrong.
 */
describe('hasLiveBasePlan legacy fallback', () => {
  it('reads a pre-abstraction Stripe subscriber as billing when no rows exist', () => {
    expect(hasLiveBasePlan([], { stripeSubscriptionId: 'sub_live' })).toBe(
      true,
    );
  });

  it('is false without the legacy facts, so nothing changes for callers that pass none', () => {
    expect(hasLiveBasePlan([])).toBe(false);
  });

  it('is false when the account has no Stripe subscription id either', () => {
    expect(hasLiveBasePlan([], { stripeSubscriptionId: null })).toBe(false);
  });

  it('ignores the free-plan sentinel, which is not a Stripe id', () => {
    // createFreeSubscription writes this string. Treating it as billing would
    // make downgradeToFree try to cancel a subscription Stripe never had.
    expect(hasLiveBasePlan([], { stripeSubscriptionId: 'free-plan' })).toBe(
      false,
    );
  });

  it('does not fire once ANY Stripe row exists — an expired one is authoritative', () => {
    // This is what `clearStaleStripeSubscription` writes to route a dead id to
    // Checkout. Falling back to the column here would hand the dead id back to
    // Stripe and reproduce the `resource_missing` 500 recovery exists to stop.
    expect(
      hasLiveBasePlan(
        [
          row({
            provider: 'stripe',
            itemType: 'BASE_PLAN',
            isDefault: true,
            providerStatus: 'expired',
          }),
        ],
        { stripeSubscriptionId: 'sub_dead' },
      ),
    ).toBe(false);
  });

  it('does not fire when a live Lemon Squeezy base plan already answers the question', () => {
    expect(
      hasLiveBasePlan(
        [
          row({
            provider: 'lemonsqueezy',
            itemType: 'BASE_PLAN',
            isDefault: true,
            providerStatus: 'active',
          }),
        ],
        { stripeSubscriptionId: null },
      ),
    ).toBe(true);
  });
});
