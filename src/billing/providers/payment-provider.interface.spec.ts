import {
  isCheckoutRequired,
  PROVIDER_ITEM_ORDER,
  PurchaseResult,
} from './payment-provider.interface';
import { LemonSqueezyAdapter } from './lemonsqueezy.adapter';
import { StripeAdapter } from './stripe.adapter';

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

describe('PaymentProviderAdapter portal, invoices and billing profile', () => {
  // Reading the prototype is what proves the method exists on the CLASS, so a
  // provider added later cannot satisfy the interface with a missing method
  // that only a runtime call would reveal.
  const METHODS = ['createPortalLink', 'listInvoices', 'getBillingProfile'];

  it.each([
    ['LemonSqueezyAdapter', LemonSqueezyAdapter],
    ['StripeAdapter', StripeAdapter],
  ])('%s implements all three', (_name, adapter) => {
    for (const method of METHODS) {
      expect(
        typeof (adapter.prototype as unknown as Record<string, unknown>)[
          method
        ],
      ).toBe('function');
    }
  });
});
