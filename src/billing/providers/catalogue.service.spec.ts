import { CatalogueService } from './catalogue.service';

type Rows = Record<string, unknown>[];

/**
 * The service issues three possible reads: provider_prices, then (for Stripe
 * only) the legacy plans / addon_pricing columns. The stub returns queued
 * results in call order.
 */
function makeDb(results: Rows[]) {
  const calls: number[] = [];
  let i = 0;
  const db = {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockImplementation(() => ({
        where: jest.fn().mockImplementation(() => ({
          limit: jest.fn().mockImplementation(() => {
            calls.push(i);
            return Promise.resolve(results[i++] ?? []);
          }),
        })),
      })),
    })),
  };
  return { db, calls };
}

describe('CatalogueService.resolveRef', () => {
  it('returns the Lemon Squeezy variant id from provider_prices', async () => {
    const { db } = makeDb([[{ providerRef: '2100632' }]]);
    const svc = new CatalogueService(db as never);
    await expect(
      svc.resolveRef('lemonsqueezy', 'PRO', 'BASE_PLAN'),
    ).resolves.toBe('2100632');
  });

  it('returns the Stripe price id from provider_prices when present', async () => {
    const { db } = makeDb([[{ providerRef: 'price_abc' }]]);
    const svc = new CatalogueService(db as never);
    await expect(svc.resolveRef('stripe', 'PRO', 'BASE_PLAN')).resolves.toBe(
      'price_abc',
    );
  });

  // Until provider_prices is populated, Stripe must keep working from the
  // columns it already uses — otherwise this change breaks live billing.
  it('falls back to plans.stripe_price_id for a Stripe base plan', async () => {
    const { db } = makeDb([[], [{ stripePriceId: 'price_legacy' }]]);
    const svc = new CatalogueService(db as never);
    await expect(svc.resolveRef('stripe', 'PRO', 'BASE_PLAN')).resolves.toBe(
      'price_legacy',
    );
  });

  it('falls back to addon_pricing.stripe_price_id for a Stripe add-on', async () => {
    const { db } = makeDb([[], [{ stripePriceId: 'price_addon' }]]);
    const svc = new CatalogueService(db as never);
    await expect(
      svc.resolveRef('stripe', 'PRO', 'EXTRA_CHANNEL'),
    ).resolves.toBe('price_addon');
  });

  // No silent fallback for Lemon Squeezy: the legacy columns hold Stripe price
  // ids, and sending one to Lemon Squeezy would fail confusingly at the API.
  it('throws for Lemon Squeezy rather than falling back to a Stripe id', async () => {
    const { db } = makeDb([[], [{ stripePriceId: 'price_legacy' }]]);
    const svc = new CatalogueService(db as never);
    await expect(
      svc.resolveRef('lemonsqueezy', 'PRO', 'BASE_PLAN'),
    ).rejects.toThrow(/not provisioned/i);
  });

  it('names the provider, plan and item type in the error', async () => {
    const { db } = makeDb([[], []]);
    const svc = new CatalogueService(db as never);
    await expect(
      svc.resolveRef('lemonsqueezy', 'MAX', 'EXTRA_MEMBER'),
    ).rejects.toThrow(/lemonsqueezy.*MAX.*EXTRA_MEMBER/i);
  });
});
