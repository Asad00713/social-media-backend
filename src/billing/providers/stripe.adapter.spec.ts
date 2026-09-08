// src/billing/providers/stripe.adapter.spec.ts
import { StripeAdapter } from './stripe.adapter';

function makeAdapter(rows: Record<string, unknown>[] = []) {
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(rows),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(undefined),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
      }),
    }),
  };
  const stripe = {
    addSubscriptionItem: jest.fn().mockResolvedValue({ id: 'si_new' }),
    updateSubscriptionItem: jest.fn().mockResolvedValue({ id: 'si_new' }),
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
  return { adapter, stripe, customers, catalogue };
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
      { itemType: 'BASE_PLAN', providerSubscriptionId: 'sub_1' },
    ]);
    const result = await adapter.purchaseAddon(1, 'EXTRA_CHANNEL', 3);
    expect(result).toEqual({ status: 'completed', quantity: 3 });
  });

  it('cancels through the existing StripeService', async () => {
    const { adapter, stripe } = makeAdapter([
      { itemType: 'BASE_PLAN', providerSubscriptionId: 'sub_1' },
    ]);
    await adapter.cancel(1, true);
    expect(stripe.cancelSubscription).toHaveBeenCalledWith('sub_1', true);
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
});
