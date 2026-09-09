import {
  isCheckoutRequired,
  PROVIDER_ITEM_ORDER,
  PurchaseResult,
} from './payment-provider.interface';

describe('isCheckoutRequired', () => {
  it('is true when the provider handed back a checkout url', () => {
    const r: PurchaseResult = {
      status: 'checkout_required',
      url: 'https://x.test/checkout',
    };
    expect(isCheckoutRequired(r)).toBe(true);
  });

  it('is false when the purchase already completed', () => {
    const r: PurchaseResult = { status: 'completed', quantity: 3 };
    expect(isCheckoutRequired(r)).toBe(false);
  });
});

describe('PROVIDER_ITEM_ORDER', () => {
  // Cancellation order is load-bearing: if a fan-out breaks midway, the
  // customer must still hold the base plan. Cancelling the base plan first
  // would end their access while add-ons kept billing.
  it('puts BASE_PLAN last so a partial failure leaves service running', () => {
    expect(PROVIDER_ITEM_ORDER[PROVIDER_ITEM_ORDER.length - 1]).toBe(
      'BASE_PLAN',
    );
  });

  it('covers every add-on type exactly once', () => {
    expect([...PROVIDER_ITEM_ORDER].sort()).toEqual(
      [
        'BASE_PLAN',
        'EXTRA_AI_TOKENS',
        'EXTRA_CHANNEL',
        'EXTRA_MEMBER',
        'EXTRA_WORKSPACE',
      ].sort(),
    );
    expect(new Set(PROVIDER_ITEM_ORDER).size).toBe(PROVIDER_ITEM_ORDER.length);
  });
});
