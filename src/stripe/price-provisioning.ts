import type Stripe from 'stripe';

/** Stable Stripe lookup_key for a plan's monthly price. */
export function planLookupKey(planCode: string): string {
  return `plan_${planCode.toLowerCase()}_monthly`;
}

/** Stable Stripe lookup_key for an addon price (per plan + type). */
export function addonLookupKey(planCode: string, addonType: string): string {
  return `addon_${addonType.toLowerCase()}_${planCode.toLowerCase()}`;
}

const ADDON_DISPLAY_NAMES: Record<string, string> = {
  EXTRA_CHANNEL: 'Extra Channel',
  EXTRA_MEMBER: 'Extra Team Member',
  EXTRA_WORKSPACE: 'Extra Workspace',
  EXTRA_AI_TOKENS: 'Extra AI Tokens',
};

/** Human-readable product name for an addon. */
export function addonDisplayName(addonType: string, planCode: string): string {
  return `${ADDON_DISPLAY_NAMES[addonType] || addonType} (${planCode})`;
}

const CURRENCY = 'usd';
const INTERVAL: Stripe.PriceCreateParams.Recurring.Interval = 'month';

interface EnsureResult {
  priceId: string;
  lookupKey: string;
  action: 'reused' | 'created' | 'repriced';
}

/**
 * Idempotently ensure a Stripe Price exists for the given lookup_key + amount.
 * Idempotency is keyed off the lookup_key *in the current Stripe account*, not
 * off any DB state — so re-running against a different account/mode provisions
 * fresh prices there.
 */
async function ensurePriceByLookupKey(
  stripe: Stripe,
  opts: {
    lookupKey: string;
    unitAmount: number;
    productName: string;
    productMetadataQuery: string;
    metadata: Record<string, string>;
  },
): Promise<EnsureResult> {
  const { lookupKey, unitAmount, productName, metadata } = opts;

  // 1. Consistent lookup by lookup_key (NOT products.search — that one lags).
  const existing = await stripe.prices.list({
    lookup_keys: [lookupKey],
    active: true,
    expand: ['data.product'],
  });

  if (existing.data.length > 0) {
    const current = existing.data[0];
    // 2. Same amount + monthly interval → reuse (idempotent no-op).
    if (
      current.unit_amount === unitAmount &&
      current.recurring?.interval === INTERVAL
    ) {
      return { priceId: current.id, lookupKey, action: 'reused' };
    }
    // 3. Amount differs → reprice on the same product.
    const productId =
      typeof current.product === 'string'
        ? current.product
        : (current.product as Stripe.Product).id;
    const repriced = await stripe.prices.create({
      product: productId,
      unit_amount: unitAmount,
      currency: CURRENCY,
      recurring: { interval: INTERVAL },
      lookup_key: lookupKey,
      transfer_lookup_key: true,
      metadata,
    });
    await stripe.prices.update(current.id, { active: false });
    return { priceId: repriced.id, lookupKey, action: 'repriced' };
  }

  // 4. No price with this lookup_key in this account → find-or-create product.
  const foundProducts = await stripe.products.search({
    query: opts.productMetadataQuery,
  });
  const productId =
    foundProducts.data.length > 0
      ? foundProducts.data[0].id
      : (
          await stripe.products.create({
            name: productName,
            metadata,
          })
        ).id;

  const created = await stripe.prices.create({
    product: productId,
    unit_amount: unitAmount,
    currency: CURRENCY,
    recurring: { interval: INTERVAL },
    lookup_key: lookupKey,
    metadata,
  });
  return { priceId: created.id, lookupKey, action: 'created' };
}

/** Ensure the monthly Price for a paid plan. Returns the Stripe price id. */
export async function ensurePlanPrice(
  stripe: Stripe,
  plan: { code: string; name: string; basePriceCents: number },
): Promise<string> {
  const lookupKey = planLookupKey(plan.code);
  const result = await ensurePriceByLookupKey(stripe, {
    lookupKey,
    unitAmount: plan.basePriceCents,
    productName: plan.name,
    productMetadataQuery: `metadata['planCode']:'${plan.code}'`,
    metadata: { planCode: plan.code },
  });
  return result.priceId;
}

/** Ensure the monthly Price for an addon. Returns the Stripe price id. */
export async function ensureAddonPrice(
  stripe: Stripe,
  addon: { planCode: string; addonType: string; pricePerUnitCents: number },
): Promise<string> {
  const lookupKey = addonLookupKey(addon.planCode, addon.addonType);
  const addonKey = `${addon.planCode}_${addon.addonType}`;
  const result = await ensurePriceByLookupKey(stripe, {
    lookupKey,
    unitAmount: addon.pricePerUnitCents,
    productName: addonDisplayName(addon.addonType, addon.planCode),
    productMetadataQuery: `metadata['addonKey']:'${addonKey}'`,
    metadata: {
      addonKey,
      addonType: addon.addonType,
      planCode: addon.planCode,
    },
  });
  return result.priceId;
}
