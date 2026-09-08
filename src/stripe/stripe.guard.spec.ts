import { assertProviderIsStripe } from './stripe-guard.util';

describe('assertProviderIsStripe', () => {
  it('allows the call when Stripe is the default provider', () => {
    expect(() => assertProviderIsStripe('stripe', 42)).not.toThrow();
  });

  // The whole point: today this call would succeed silently against the wrong
  // provider and only surface weeks later as a billing discrepancy.
  it('refuses a Stripe call for a Lemon Squeezy subscription', () => {
    expect(() => assertProviderIsStripe('lemonsqueezy', 42)).toThrow(
      /lemonsqueezy/i,
    );
  });

  it('names the subscription so the failure is traceable', () => {
    expect(() => assertProviderIsStripe('lemonsqueezy', 42)).toThrow(/42/);
  });

  // A subscription with no provider rows yet is mid-creation. Blocking it
  // would break Stripe signup, which is the path that CREATES the row.
  it('allows the call when no provider is recorded yet', () => {
    expect(() => assertProviderIsStripe(null, 42)).not.toThrow();
  });
});
