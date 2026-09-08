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

export async function seedProviderPrices(): Promise<void> {
  const { resolved, skipped } = resolvePrices(process.env);

  // Echo the store, never the key. `stripe-provision.ts` does the same before
  // it writes: a seed that provisions against a payment provider should say
  // out loud which account it is aimed at, because the failure mode of getting
  // it wrong is billing real people against the wrong store.
  const storeId = process.env.LEMONSQUEEZY_STORE_ID ?? '(unset)';
  console.log('==========================================');
  console.log(`Seeding provider_prices — lemonsqueezy store ${storeId}`);
  console.log('==========================================');

  await upsertProviderPrices(resolved);

  for (const row of resolved) {
    console.log(
      `- ${row.planCode} / ${row.itemType}: variant ${row.providerRef}`,
    );
  }

  // Skips are logged rather than written. An unset variable means we do not
  // know the id, and inserting a blank `provider_ref` would turn a clean
  // "not provisioned" error into a failure inside the provider's API.
  for (const row of skipped) {
    console.log(
      `- ${row.planCode} / ${row.itemType}: SKIPPED (${row.envVar} ${row.reason})`,
    );
  }

  // The outstanding catalogue gap. EXTRA_MEMBER, EXTRA_WORKSPACE and
  // EXTRA_AI_TOKENS have no Lemon Squeezy product yet, so their adapter paths
  // cannot be exercised live. Printed, so re-running this seed after creating
  // those products in the dashboard tells you what is still left.
  const missing = await missingCatalogueRows('lemonsqueezy');
  if (missing.length > 0) {
    console.log('');
    console.log(
      `${missing.length} catalogue entries have NO lemonsqueezy price. ` +
        `Buying one throws "not provisioned" (a clean 400, no charge):`,
    );
    for (const gap of missing) {
      console.log(`  ! ${gap.planCode} / ${gap.itemType}`);
    }
    console.log(
      'Create the product in the Lemon Squeezy dashboard, add its variant id ' +
        'to the environment, and re-run this seed.',
    );
  }

  console.log('');
  console.log(
    `provider_prices seeded: ${resolved.length} written, ${skipped.length} skipped.`,
  );
}

if (require.main === module) {
  seedProviderPrices()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('provider_prices seed failed:', error);
      process.exit(1);
    });
}
