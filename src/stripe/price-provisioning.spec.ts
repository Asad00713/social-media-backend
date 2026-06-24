import {
  planLookupKey,
  addonLookupKey,
  addonDisplayName,
  ensurePlanPrice,
  ensureAddonPrice,
} from './price-provisioning';

describe('lookup key helpers', () => {
  it('builds plan lookup keys (lowercased, monthly)', () => {
    expect(planLookupKey('PRO')).toBe('plan_pro_monthly');
    expect(planLookupKey('BASIC')).toBe('plan_basic_monthly');
    expect(planLookupKey('MAX')).toBe('plan_max_monthly');
  });

  it('builds addon lookup keys as addon_<type>_<plan> lowercased', () => {
    expect(addonLookupKey('PRO', 'EXTRA_CHANNEL')).toBe(
      'addon_extra_channel_pro',
    );
    expect(addonLookupKey('MAX', 'AI_TOKENS')).toBe('addon_ai_tokens_max');
  });

  it('produces human display names for all addon types', () => {
    expect(addonDisplayName('EXTRA_CHANNEL', 'PRO')).toBe('Extra Channel (PRO)');
    expect(addonDisplayName('AI_TOKENS', 'MAX')).toBe('AI Tokens (MAX)');
    expect(addonDisplayName('UNKNOWN_X', 'PRO')).toBe('UNKNOWN_X (PRO)');
  });
});

// Minimal fake Stripe capturing calls and simulating lookup_key state.
function makeFakeStripe(initialPrices: any[] = []) {
  const prices = [...initialPrices];
  const products: any[] = [];
  let priceSeq = 1000;
  let productSeq = 1;
  return {
    _prices: prices,
    _products: products,
    prices: {
      list: jest.fn(async ({ lookup_keys }: any) => ({
        data: prices.filter(
          (p) => p.active && lookup_keys.includes(p.lookup_key),
        ),
      })),
      create: jest.fn(async (args: any) => {
        // transfer_lookup_key: strip the key off any other price holding it
        if (args.transfer_lookup_key && args.lookup_key) {
          for (const p of prices) {
            if (p.lookup_key === args.lookup_key) p.lookup_key = null;
          }
        }
        const price = {
          id: `price_${priceSeq++}`,
          active: true,
          unit_amount: args.unit_amount,
          recurring: args.recurring,
          lookup_key: args.lookup_key ?? null,
          product:
            typeof args.product === 'string'
              ? args.product
              : args.product?.id,
        };
        prices.push(price);
        return price;
      }),
      update: jest.fn(async (id: string, args: any) => {
        const p = prices.find((x) => x.id === id);
        if (p) Object.assign(p, args);
        return p;
      }),
    },
    products: {
      search: jest.fn(async () => ({ data: [...products] })),
      create: jest.fn(async (args: any) => {
        const product = { id: `prod_${productSeq++}`, ...args };
        products.push(product);
        return product;
      }),
    },
  } as any;
}

describe('ensurePlanPrice', () => {
  it('creates product + price with lookup_key when none exists', async () => {
    const stripe = makeFakeStripe();
    const id = await ensurePlanPrice(stripe, {
      code: 'PRO',
      name: 'Pro Plan',
      basePriceCents: 1000,
    });
    expect(id).toMatch(/^price_/);
    expect(stripe.products.create).toHaveBeenCalledTimes(1);
    expect(stripe.prices.create).toHaveBeenCalledTimes(1);
    const created = stripe._prices[0];
    expect(created.lookup_key).toBe('plan_pro_monthly');
    expect(created.unit_amount).toBe(1000);
    expect(created.recurring.interval).toBe('month');
  });

  it('is idempotent: same amount returns existing id, creates nothing', async () => {
    const stripe = makeFakeStripe([
      {
        id: 'price_existing',
        active: true,
        unit_amount: 1000,
        recurring: { interval: 'month' },
        lookup_key: 'plan_pro_monthly',
        product: 'prod_existing',
      },
    ]);
    const id = await ensurePlanPrice(stripe, {
      code: 'PRO',
      name: 'Pro Plan',
      basePriceCents: 1000,
    });
    expect(id).toBe('price_existing');
    expect(stripe.prices.create).not.toHaveBeenCalled();
    expect(stripe.products.create).not.toHaveBeenCalled();
  });

  it('reprices: different amount creates new price, transfers key, deactivates old', async () => {
    const stripe = makeFakeStripe([
      {
        id: 'price_old',
        active: true,
        unit_amount: 1000,
        recurring: { interval: 'month' },
        lookup_key: 'plan_pro_monthly',
        product: 'prod_existing',
      },
    ]);
    const id = await ensurePlanPrice(stripe, {
      code: 'PRO',
      name: 'Pro Plan',
      basePriceCents: 1200,
    });
    expect(id).not.toBe('price_old');
    const newPrice = stripe._prices.find((p: any) => p.id === id);
    expect(newPrice.unit_amount).toBe(1200);
    expect(newPrice.lookup_key).toBe('plan_pro_monthly');
    expect(newPrice.product).toBe('prod_existing'); // same product reused
    const old = stripe._prices.find((p: any) => p.id === 'price_old');
    expect(old.active).toBe(false); // deactivated
  });
});

describe('ensureAddonPrice', () => {
  it('creates addon price with addon lookup_key + metadata', async () => {
    const stripe = makeFakeStripe();
    const id = await ensureAddonPrice(stripe, {
      planCode: 'PRO',
      addonType: 'EXTRA_CHANNEL',
      pricePerUnitCents: 500,
    });
    expect(id).toMatch(/^price_/);
    const created = stripe._prices[0];
    expect(created.lookup_key).toBe('addon_extra_channel_pro');
    expect(created.unit_amount).toBe(500);
  });
});
