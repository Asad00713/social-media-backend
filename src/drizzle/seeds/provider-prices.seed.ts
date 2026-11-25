import { config } from 'dotenv';
config({ path: '.env' });

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import {
  providerPrices,
  plans,
  addonPricing,
  PaymentProvider,
  ProviderItemType,
} from '../schema';

/**
 * What each plan and add-on is called at Lemon Squeezy.
 *
 * `CatalogueService.resolveRef` is the ONLY reader of `provider_prices`, and
 * for Lemon Squeezy it has no fallback on purpose: the legacy
 * `plans.stripe_price_id` / `addon_pricing.stripe_price_id` columns hold Stripe
 * price ids, and handing one to Lemon Squeezy would fail deep inside their API
 * with a message that names nothing. A missing row therefore throws a
 * BadRequestException naming the provider, plan and item type — before any
 * money moves. That is the good failure, and this seed is what prevents it.
 *
 * Every id is read from the environment. Nothing is hard-coded, because the
 * TEST-mode variant ids and the eventual live ones are different numbers and a
 * committed id would silently bill against the wrong store.
 */

/** One row this seed intends to write, before the env lookup. */
interface PlannedPrice {
  provider: PaymentProvider;
  planCode: string;
  itemType: ProviderItemType;
  /** The environment variable that carries the provider's id for this row. */
  envVar: string;
}

/**
 * The four rows Lemon Squeezy can serve today.
 *
 * `plan_code` is NEVER null here, and that is load-bearing rather than
 * cosmetic. `provider_prices.plan_code` is nullable, and Postgres treats NULLs
 * as distinct inside a UNIQUE constraint, so a row written with a null
 * plan_code could never conflict — the upsert below would insert a duplicate
 * on every run instead of updating. It also matches how the adapter reads:
 * `LemonSqueezyAdapter.purchaseAddon` resolves an add-on with the ACCOUNT's own
 * plan code (`accountOf(subscriptionId).planCode`), never with null, so a
 * null-keyed row would be unreachable even if it were written.
 */
export const LEMONSQUEEZY_PRICES: readonly PlannedPrice[] = [
  {
    provider: 'lemonsqueezy',
    planCode: 'BASIC',
    itemType: 'BASE_PLAN',
    envVar: 'LEMONSQUEEZY_VARIANT_BASIC',
  },
  {
    provider: 'lemonsqueezy',
    planCode: 'PRO',
    itemType: 'BASE_PLAN',
    envVar: 'LEMONSQUEEZY_VARIANT_PRO',
  },
  {
    provider: 'lemonsqueezy',
    planCode: 'MAX',
    itemType: 'BASE_PLAN',
    envVar: 'LEMONSQUEEZY_VARIANT_MAX',
  },
  {
    provider: 'lemonsqueezy',
    planCode: 'PRO',
    itemType: 'EXTRA_CHANNEL',
    envVar: 'LEMONSQUEEZY_VARIANT_EXTRA_CHANNEL',
  },
] as const;

/**
 * The fifteen rows Paddle can serve: a base plan plus four add-ons on each of
 * BASIC, PRO and MAX.
 *
 * Paddle covers the WHOLE catalogue where Lemon Squeezy covers four rows, so
 * `missingCatalogueRows('paddle')` should report nothing once these are
 * seeded. That is the point of listing them all: the add-on paths
 * (`purchaseAddon`, `changeAddonQuantity`, `removeAddon`) cannot be exercised
 * at all until a price exists for the pair being bought.
 *
 * The add-on rows are per PLAN, not shared, and that is not redundancy: the
 * same add-on costs different money on different tiers (a channel is $5 on
 * BASIC and PRO but $3 on MAX), so each tier has its own Paddle price. The
 * unique constraint is `(provider, plan_code, item_type)`, so these fifteen
 * are fifteen distinct keys rather than five with three spellings.
 *
 * As with Lemon Squeezy, every id comes from the environment. A Paddle price
 * id is NOT reusable across accounts — the sandbox ids in
 * `docs/billing/paddle-sandbox-catalogue.md` do not exist on the live account
 * — so committing one here would point production at a sandbox price, or at a
 * deleted one. The env var is what makes the same seed correct in both places.
 */
export const PADDLE_PRICES: readonly PlannedPrice[] = [
  // BASIC
  {
    provider: 'paddle',
    planCode: 'BASIC',
    itemType: 'BASE_PLAN',
    envVar: 'PADDLE_PRICE_BASIC',
  },
  {
    provider: 'paddle',
    planCode: 'BASIC',
    itemType: 'EXTRA_CHANNEL',
    envVar: 'PADDLE_PRICE_BASIC_EXTRA_CHANNEL',
  },
  {
    provider: 'paddle',
    planCode: 'BASIC',
    itemType: 'EXTRA_MEMBER',
    envVar: 'PADDLE_PRICE_BASIC_EXTRA_MEMBER',
  },
  {
    provider: 'paddle',
    planCode: 'BASIC',
    itemType: 'EXTRA_WORKSPACE',
    envVar: 'PADDLE_PRICE_BASIC_EXTRA_WORKSPACE',
  },
  {
    provider: 'paddle',
    planCode: 'BASIC',
    itemType: 'EXTRA_AI_TOKENS',
    envVar: 'PADDLE_PRICE_BASIC_EXTRA_AI_TOKENS',
  },
  // PRO
  {
    provider: 'paddle',
    planCode: 'PRO',
    itemType: 'BASE_PLAN',
    envVar: 'PADDLE_PRICE_PRO',
  },
  {
    provider: 'paddle',
    planCode: 'PRO',
    itemType: 'EXTRA_CHANNEL',
    envVar: 'PADDLE_PRICE_PRO_EXTRA_CHANNEL',
  },
  {
    provider: 'paddle',
    planCode: 'PRO',
    itemType: 'EXTRA_MEMBER',
    envVar: 'PADDLE_PRICE_PRO_EXTRA_MEMBER',
  },
  {
    provider: 'paddle',
    planCode: 'PRO',
    itemType: 'EXTRA_WORKSPACE',
    envVar: 'PADDLE_PRICE_PRO_EXTRA_WORKSPACE',
  },
  {
    provider: 'paddle',
    planCode: 'PRO',
    itemType: 'EXTRA_AI_TOKENS',
    envVar: 'PADDLE_PRICE_PRO_EXTRA_AI_TOKENS',
  },
  // MAX
  {
    provider: 'paddle',
    planCode: 'MAX',
    itemType: 'BASE_PLAN',
    envVar: 'PADDLE_PRICE_MAX',
  },
  {
    provider: 'paddle',
    planCode: 'MAX',
    itemType: 'EXTRA_CHANNEL',
    envVar: 'PADDLE_PRICE_MAX_EXTRA_CHANNEL',
  },
  {
    provider: 'paddle',
    planCode: 'MAX',
    itemType: 'EXTRA_MEMBER',
    envVar: 'PADDLE_PRICE_MAX_EXTRA_MEMBER',
  },
  {
    provider: 'paddle',
    planCode: 'MAX',
    itemType: 'EXTRA_WORKSPACE',
    envVar: 'PADDLE_PRICE_MAX_EXTRA_WORKSPACE',
  },
  {
    provider: 'paddle',
    planCode: 'MAX',
    itemType: 'EXTRA_AI_TOKENS',
    envVar: 'PADDLE_PRICE_MAX_EXTRA_AI_TOKENS',
  },
] as const;

/** A row whose env var resolved to a usable provider id. */
export interface ResolvedPrice extends PlannedPrice {
  providerRef: string;
}

/** A row that could not be written, and the variable that would fix it. */
export interface SkippedPrice extends PlannedPrice {
  reason: 'env var is not set';
}

export interface ResolutionOutcome {
  resolved: ResolvedPrice[];
  skipped: SkippedPrice[];
}

/**
 * Split the planned rows by whether their env var carries a value.
 *
 * Pure, so the seed's real decision — write this, skip that — is testable
 * without a database or a network. An unset OR blank variable is a skip, not a
 * write: `provider_ref` is NOT NULL, so an empty string would satisfy the
 * column while making `resolveRef` return `''`, which the adapter would send to
 * Lemon Squeezy as `variant_id: NaN`. A missing row throws a named error; a
 * blank row fails inside the provider's API. The missing row is strictly
 * better, so a blank env var must never become one.
 */
export function resolvePrices(
  env: NodeJS.ProcessEnv,
  planned: readonly PlannedPrice[] = LEMONSQUEEZY_PRICES,
): ResolutionOutcome {
  const resolved: ResolvedPrice[] = [];
  const skipped: SkippedPrice[] = [];

  for (const row of planned) {
    const raw = env[row.envVar]?.trim();
    if (!raw) {
      skipped.push({ ...row, reason: 'env var is not set' });
      continue;
    }
    resolved.push({ ...row, providerRef: raw });
  }

  return { resolved, skipped };
}

/**
 * Every (plan, item type) pair a customer can actually try to buy, read from
 * the catalogue tables rather than restated here — restating it is how a new
 * add-on tier gets added to `addon_pricing` and quietly has no Lemon Squeezy
 * row for a month.
 *
 * FREE is excluded, and the exclusion is verified rather than assumed: both
 * paths that could reach `resolveRef` with it are already closed.
 * `subscription.service.ts` rejects `basePriceCents <= 0` with "FREE plan does
 * not require checkout" BEFORE calling the adapter, and
 * `plan-change.service.ts` routes `newPlanCode === 'FREE'` into
 * `downgradeToFree`, which cancels rather than repricing. So a FREE row would
 * be unreachable, and listing it as a gap would be noise that trains the
 * reader to ignore this report.
 */
export async function billableCatalogueKeys(
  database: typeof db = db,
): Promise<{ planCode: string; itemType: ProviderItemType }[]> {
  const paidPlans = await database
    .select({ code: plans.code, basePriceCents: plans.basePriceCents })
    .from(plans)
    .where(eq(plans.isActive, true));

  const keys: { planCode: string; itemType: ProviderItemType }[] = [];

  for (const plan of paidPlans) {
    if (plan.basePriceCents <= 0) continue;
    keys.push({ planCode: plan.code, itemType: 'BASE_PLAN' });
  }

  const addons = await database
    .select({
      planCode: addonPricing.planCode,
      addonType: addonPricing.addonType,
    })
    .from(addonPricing)
    .where(eq(addonPricing.isActive, true));

  for (const addon of addons) {
    keys.push({
      planCode: addon.planCode,
      itemType: addon.addonType as ProviderItemType,
    });
  }

  return keys;
}

/**
 * Upsert the resolved rows on the `(provider, plan_code, item_type)` unique
 * constraint.
 *
 * `provider_ref` IS updated on conflict, unlike `plans.stripe_price_id` in the
 * plans seed. The reason they differ: a Stripe price id is immutable once
 * customers are subscribed to it, so overwriting it would orphan them; a Lemon
 * Squeezy variant id here is being pointed at a store that is still in test
 * mode, and re-running after recreating a test product must move the pointer
 * rather than leave it aimed at a deleted variant. `is_active` is re-asserted
 * too, so a row previously deactivated by hand comes back when it is seeded
 * again.
 */
export async function upsertProviderPrices(
  rows: readonly ResolvedPrice[],
  database: typeof db = db,
): Promise<void> {
  if (rows.length === 0) return;

  for (const row of rows) {
    await database
      .insert(providerPrices)
      .values({
        provider: row.provider,
        planCode: row.planCode,
        itemType: row.itemType,
        providerRef: row.providerRef,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: [
          providerPrices.provider,
          providerPrices.planCode,
          providerPrices.itemType,
        ],
        set: {
          providerRef: row.providerRef,
          isActive: true,
          updatedAt: new Date(),
        },
      });
  }
}

/**
 * What a customer could ask to buy that this provider still cannot sell.
 *
 * Every gap here is a live `BadRequestException` waiting for the first
 * customer who clicks it, so the seed prints them rather than exiting 0 and
 * looking finished.
 */
export async function missingCatalogueRows(
  provider: PaymentProvider,
  database: typeof db = db,
): Promise<{ planCode: string; itemType: ProviderItemType }[]> {
  const wanted = await billableCatalogueKeys(database);
  if (wanted.length === 0) return [];

  const present = await database
    .select({
      planCode: providerPrices.planCode,
      itemType: providerPrices.itemType,
    })
    .from(providerPrices)
    .where(
      and(
        eq(providerPrices.provider, provider),
        eq(providerPrices.isActive, true),
        inArray(
          providerPrices.planCode,
          wanted.map((k) => k.planCode),
        ),
      ),
    );

  const have = new Set(present.map((p) => `${p.planCode}/${p.itemType}`));
  return wanted.filter((k) => !have.has(`${k.planCode}/${k.itemType}`));
}

/**
 * Which provider this run is seeding, and what to echo as the account it is
 * aimed at.
 *
 * The account is ECHOED but the key never is. `stripe-provision.ts` does the
 * same: a seed that writes payment ids should say out loud which account it is
 * pointed at, because the failure mode of getting it wrong is billing real
 * people against the wrong store. For Paddle the account is implied by the API
 * BASE rather than a store id — sandbox and live are different hosts — so that
 * is what gets printed.
 */
const PROVIDER_PLANS: Record<
  'lemonsqueezy' | 'paddle',
  { rows: readonly PlannedPrice[]; account: () => string }
> = {
  lemonsqueezy: {
    rows: LEMONSQUEEZY_PRICES,
    account: () => `store ${process.env.LEMONSQUEEZY_STORE_ID ?? '(unset)'}`,
  },
  paddle: {
    rows: PADDLE_PRICES,
    account: () => `api ${process.env.PADDLE_API_BASE ?? '(unset)'}`,
  },
};

/**
 * Seed one provider's prices.
 *
 * The provider comes from argv so the same script serves both, rather than a
 * second copy of this reporting drifting away from the first:
 *
 *   npx ts-node src/drizzle/seeds/provider-prices.seed.ts paddle
 *
 * It defaults to lemonsqueezy, which is what every existing invocation of this
 * file means.
 */
export async function seedProviderPrices(
  provider: 'lemonsqueezy' | 'paddle' = 'lemonsqueezy',
): Promise<void> {
  const plan = PROVIDER_PLANS[provider];
  if (!plan) {
    throw new Error(
      `Unknown provider "${provider}". Expected lemonsqueezy or paddle.`,
    );
  }

  const { resolved, skipped } = resolvePrices(process.env, plan.rows);

  console.log('==========================================');
  console.log(`Seeding provider_prices — ${provider} ${plan.account()}`);
  console.log('==========================================');

  await upsertProviderPrices(resolved);

  for (const row of resolved) {
    console.log(`- ${row.planCode} / ${row.itemType}: ${row.providerRef}`);
  }

  // Skips are logged rather than written. An unset variable means we do not
  // know the id, and inserting a blank `provider_ref` would turn a clean
  // "not provisioned" error into a failure inside the provider's API.
  for (const row of skipped) {
    console.log(
      `- ${row.planCode} / ${row.itemType}: SKIPPED (${row.envVar} ${row.reason})`,
    );
  }

  // The outstanding catalogue gap: what a customer could ask to buy that this
  // provider still cannot sell. Every entry is a live BadRequestException
  // waiting for the first customer who clicks it, so the seed prints them
  // rather than exiting 0 and looking finished.
  const missing = await missingCatalogueRows(provider);
  if (missing.length > 0) {
    console.log('');
    console.log(
      `${missing.length} catalogue entries have NO ${provider} price. ` +
        `Buying one throws "not provisioned" (a clean 400, no charge):`,
    );
    for (const gap of missing) {
      console.log(`  ! ${gap.planCode} / ${gap.itemType}`);
    }
    console.log(
      `Create the price in the ${provider} dashboard, add its id to the ` +
        'environment, and re-run this seed.',
    );
  }

  console.log('');
  console.log(
    `provider_prices seeded: ${resolved.length} written, ${skipped.length} skipped.`,
  );
}

if (require.main === module) {
  const arg = process.argv[2];
  if (arg && arg !== 'lemonsqueezy' && arg !== 'paddle') {
    console.error(
      `Unknown provider "${arg}". Expected lemonsqueezy or paddle.`,
    );
    process.exit(1);
  }
  seedProviderPrices(arg as 'lemonsqueezy' | 'paddle' | undefined)
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('provider_prices seed failed:', error);
      process.exit(1);
    });
}
