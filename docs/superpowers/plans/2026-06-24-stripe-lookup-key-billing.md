# Stripe lookup_key Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Stripe billing from runtime "create-on-checkout" to the industry-standard model — Products/Prices are provisioned once (idempotently, by `lookup_key`), the app only **reads** the stored `stripePriceId` at checkout, and a standalone script provisions/repprices into whatever Stripe account/mode the key points at.

**Architecture:** Pure, testable price-provisioning helpers in `src/stripe/price-provisioning.ts` (lookup-key derivation + `ensurePlanPrice` / `ensureAddonPrice`, idempotent via consistent `prices.list({ lookup_keys })`). A standalone seed-style script `src/drizzle/seeds/stripe-provision.ts` calls them and writes the resolved price ids back to the DB. The three billing services (`subscription`, `plan-change`, `addon`) stop creating prices at runtime and instead read the stored id or throw a clear "not provisioned" error. The now-dead `getOrCreatePriceForPlan/Addon` methods are removed from `StripeService`.

**Tech Stack:** NestJS, Drizzle ORM (node-postgres), Stripe Node SDK (already a dep), Jest.

**Key design decision (account-switch safety):** Idempotency keys off **"does a price with this `lookup_key` exist in the *current* Stripe account"** — NOT off "the DB already has a `stripePriceId`". This makes switching accounts (old test account → new live account later) safe: re-running the script against a new account's key finds no matching lookup_key there and creates fresh prices, then overwrites the DB ids. The DB id is only a runtime cache; the lookup_key is the stable identity.

**Reference spec:** `docs/superpowers/specs/2026-06-23-railway-migration-and-stripe-billing-design.md` (Part 2 + Part 4).

**Seed state (already committed):** 4 plans — `FREE` ($0, exempt), `BASIC` ($5), `PRO` ($10), `MAX` ($50). Addons exist for `PRO` and `MAX` only (4 types each: `EXTRA_CHANNEL`, `EXTRA_MEMBER`, `EXTRA_WORKSPACE`, `AI_TOKENS`). `BASIC` has no addons. So the provision script creates **3 plan prices** (BASIC/PRO/MAX) + **8 addon prices** = 11 prices.

---

## lookup_key scheme

| Entity | lookup_key | Example |
|---|---|---|
| Plan (monthly) | `plan_<code-lower>_monthly` | `plan_pro_monthly`, `plan_basic_monthly` |
| Addon | `addon_<type-lower>_<plan-lower>` | `addon_extra_channel_pro`, `addon_ai_tokens_max` |

FREE has `basePriceCents = 0` → **no** Stripe price, **no** lookup_key.

---

## File structure

- **Create** `src/stripe/price-provisioning.ts` — pure helpers: `planLookupKey`, `addonLookupKey`, `addonDisplayName`, `ensurePlanPrice`, `ensureAddonPrice`. No Nest, no DB — takes a `Stripe` instance. Unit-testable with a fake Stripe.
- **Create** `src/stripe/price-provisioning.spec.ts` — Jest unit tests with a hand-rolled fake Stripe.
- **Create** `src/drizzle/seeds/stripe-provision.ts` — standalone runner (seed style: `import { db }`, `new Stripe(env)`); reads plans/addons, calls ensure helpers, writes back ids, prints account/mode guard + summary.
- **Modify** `src/billing/services/subscription.service.ts` (~L121–138) — read-only.
- **Modify** `src/billing/services/plan-change.service.ts` (~L292–309) — read-only.
- **Modify** `src/billing/services/addon.service.ts` (~L174–196) — read-only.
- **Modify** `src/stripe/stripe.service.ts` — remove dead `getOrCreatePriceForPlan`, `getOrCreatePriceForAddon`, `getAddonDisplayName`.
- **Modify** `docs/super-admin-api.md` — add "Pricing & Stripe Operations" runbook section.

---

## Task 1: lookup_key derivation helpers

**Files:**
- Create: `src/stripe/price-provisioning.ts`
- Test: `src/stripe/price-provisioning.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/stripe/price-provisioning.spec.ts`:

```ts
import {
  planLookupKey,
  addonLookupKey,
  addonDisplayName,
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/stripe/price-provisioning.spec.ts`
Expected: FAIL — cannot find module `./price-provisioning`.

- [ ] **Step 3: Write minimal implementation**

Create `src/stripe/price-provisioning.ts` (helpers only for now):

```ts
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
  AI_TOKENS: 'AI Tokens',
};

/** Human-readable product name for an addon. */
export function addonDisplayName(addonType: string, planCode: string): string {
  return `${ADDON_DISPLAY_NAMES[addonType] || addonType} (${planCode})`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/stripe/price-provisioning.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/stripe/price-provisioning.ts src/stripe/price-provisioning.spec.ts
git commit -m "feat(billing): lookup_key derivation + addon name helpers"
```

---

## Task 2: `ensurePlanPrice` / `ensureAddonPrice` (idempotent, reprice-safe)

**Files:**
- Modify: `src/stripe/price-provisioning.ts`
- Test: `src/stripe/price-provisioning.spec.ts`

**Behavior (both functions identical except metadata + product name):**
1. Consistent lookup: `stripe.prices.list({ lookup_keys: [key], active: true, expand: ['data.product'] })`.
2. If a price exists with the **same** `unit_amount` and monthly interval → return its id (idempotent no-op).
3. If a price exists with a **different** amount → reprice: create a new price on the same product with `lookup_key` + `transfer_lookup_key: true`, deactivate the old price, return the new id.
4. If **no** price has that lookup_key in this account → find-or-create the product (by `metadata` match via `products.search`, else create), then create the price with `lookup_key`, return its id.

- [ ] **Step 1: Write the failing tests**

Append to `src/stripe/price-provisioning.spec.ts`:

```ts
import { ensurePlanPrice, ensureAddonPrice } from './price-provisioning';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/stripe/price-provisioning.spec.ts`
Expected: FAIL — `ensurePlanPrice`/`ensureAddonPrice` are not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/stripe/price-provisioning.ts`:

```ts
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
        : current.product.id;
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/stripe/price-provisioning.spec.ts`
Expected: PASS (all suites — helpers + ensurePlanPrice + ensureAddonPrice).

- [ ] **Step 5: Commit**

```bash
git add src/stripe/price-provisioning.ts src/stripe/price-provisioning.spec.ts
git commit -m "feat(billing): idempotent ensurePlanPrice/ensureAddonPrice by lookup_key"
```

---

## Task 3: Provision script (`stripe-provision.ts`)

**Files:**
- Create: `src/drizzle/seeds/stripe-provision.ts`

This is a standalone runner (no Jest test — it has live side effects; it is verified by the manual smoke run in the cutover checklist). It mirrors `plans.seed.ts` style: load `.env`, import `db`, construct a `Stripe` client directly, print an account/mode guard, then provision.

- [ ] **Step 1: Write the script**

Create `src/drizzle/seeds/stripe-provision.ts`:

```ts
import { config } from 'dotenv';
config({ path: '.env' });

import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { plans, addonPricing } from '../schema';
import { ensurePlanPrice, ensureAddonPrice } from '../../stripe/price-provisioning';

async function provision() {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) {
    throw new Error('STRIPE_SECRET_KEY is not defined');
  }

  const stripe = new Stripe(apiKey, { apiVersion: '2025-02-24.acacia' });

  // Guard: echo which account/mode we are about to write into.
  const mode = apiKey.startsWith('sk_live') ? 'LIVE' : 'TEST';
  const account = await stripe.accounts.retrieve();
  console.log('==========================================');
  console.log(`Stripe provisioning — mode: ${mode}`);
  console.log(`Account: ${account.id} (${account.settings?.dashboard?.display_name ?? 'n/a'})`);
  console.log('==========================================');

  // 1. Paid plans (FREE has basePriceCents = 0 → skipped, no Stripe price).
  const allPlans = await db.select().from(plans);
  for (const plan of allPlans) {
    if (plan.basePriceCents <= 0) {
      console.log(`- plan ${plan.code}: free, no Stripe price (skipped)`);
      continue;
    }
    const priceId = await ensurePlanPrice(stripe, {
      code: plan.code,
      name: plan.name,
      basePriceCents: plan.basePriceCents,
    });
    await db
      .update(plans)
      .set({ stripePriceId: priceId, updatedAt: new Date() })
      .where(eq(plans.code, plan.code));
    console.log(`- plan ${plan.code}: ${priceId}`);
  }

  // 2. Addons.
  const allAddons = await db.select().from(addonPricing);
  for (const addon of allAddons) {
    const priceId = await ensureAddonPrice(stripe, {
      planCode: addon.planCode,
      addonType: addon.addonType,
      pricePerUnitCents: addon.pricePerUnitCents,
    });
    await db
      .update(addonPricing)
      .set({ stripePriceId: priceId })
      .where(eq(addonPricing.id, addon.id));
    console.log(`- addon ${addon.planCode}/${addon.addonType}: ${priceId}`);
  }

  console.log('Stripe provisioning complete.');
}

if (require.main === module) {
  provision()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Stripe provisioning failed:', error);
      process.exit(1);
    });
}

export { provision };
```

> **Implementer note:** Confirm the `apiVersion` string matches the one already used in `src/stripe/stripe.service.ts` (`this.stripe = new Stripe(apiKey, { apiVersion: ... })`). Use that exact value here so the SDK types line up. Read it first; do not assume `'2025-02-24.acacia'`.

- [ ] **Step 2: Verify it compiles (no live run in this task)**

Run: `npm run build`
Expected: build succeeds (the script type-checks against the Stripe SDK + Drizzle schema). Do NOT execute the script here — execution is an operator step against a real Stripe key (cutover checklist).

- [ ] **Step 3: Commit**

```bash
git add src/drizzle/seeds/stripe-provision.ts
git commit -m "feat(billing): standalone stripe-provision script (lookup_key, account-safe)"
```

---

## Task 4: Read-only checkout in the 3 billing services

**Files:**
- Modify: `src/billing/services/subscription.service.ts` (~L121–138)
- Modify: `src/billing/services/plan-change.service.ts` (~L292–309)
- Modify: `src/billing/services/addon.service.ts` (~L174–196)

No new tests (these are integration paths with no unit harness); verified by `npm run build` + the cutover smoke tests. Each change replaces "create-if-missing + write-back" with "read stored id, else throw".

**Pre-check (all three):** ensure `BadRequestException` is imported from `@nestjs/common` in each file. `addon.service.ts` already uses it. For the other two, if it is not in the import list, add it. Verify by reading the top-of-file imports before editing.

- [ ] **Step 1: subscription.service.ts — replace the create block**

Find (around L121–138):

```ts
    // 7. Get or create Stripe price for the plan
    let stripePriceId = selectedPlan.stripePriceId;

    if (!stripePriceId) {
      // Dynamically create price in Stripe if not configured
      stripePriceId = await this.stripeService.getOrCreatePriceForPlan({
        planCode: selectedPlan.code,
        planName: selectedPlan.name,
        priceCents: selectedPlan.basePriceCents,
        interval: 'month',
      });

      // Optionally update the plan in database with the new price ID
      await db
        .update(plans)
        .set({ stripePriceId })
        .where(eq(plans.code, selectedPlan.code));
    }
```

Replace with:

```ts
    // 7. Read the provisioned Stripe price for the plan (read-only — prices are
    //    provisioned out-of-band by the stripe-provision script; FREE returned
    //    above at step 5, so only paid plans reach here).
    const stripePriceId = selectedPlan.stripePriceId;

    if (!stripePriceId) {
      throw new BadRequestException(
        `Plan "${selectedPlan.code}" is not provisioned in Stripe — run the pricing provision script (npx ts-node src/drizzle/seeds/stripe-provision.ts)`,
      );
    }
```

> The `plans` import and `eq` may become unused in this file after this change. After editing, check whether they are referenced elsewhere in the file; if not, remove them from the imports to keep the build clean (`npm run build` will flag unused via lint, not type errors — run `npm run lint` to confirm). `db` is still used elsewhere (subscription insert), keep it.

- [ ] **Step 2: plan-change.service.ts — replace the create block**

Find (around L292–309):

```ts
    // 4. Get or create Stripe price for the target plan
    let targetPriceId = target.stripePriceId;

    if (!targetPriceId && target.basePriceCents > 0) {
      // Dynamically create price in Stripe if not configured
      targetPriceId = await this.stripeService.getOrCreatePriceForPlan({
        planCode: target.code,
        planName: target.name,
        priceCents: target.basePriceCents,
        interval: 'month',
      });

      // Update the plan in database with the new price ID
      await db
        .update(plans)
        .set({ stripePriceId: targetPriceId })
        .where(eq(plans.code, target.code));
    }
```

Replace with:

```ts
    // 4. Read the provisioned Stripe price for the target plan (read-only).
    //    FREE (basePriceCents === 0) has no price — targetPriceId stays empty
    //    and the downstream `if (sub.stripeSubscriptionId && targetPriceId)`
    //    branch handles the free path.
    const targetPriceId = target.stripePriceId;

    if (!targetPriceId && target.basePriceCents > 0) {
      throw new BadRequestException(
        `Plan "${target.code}" is not provisioned in Stripe — run the pricing provision script (npx ts-node src/drizzle/seeds/stripe-provision.ts)`,
      );
    }
```

> `targetPriceId` was `let` (reassigned). After this change it is only read; making it `const` is correct. Verify nothing later in the method reassigns `targetPriceId` — the grep showed it is only *read* at L315/L444/L466. If any reassignment exists, keep `let`. Check `plans`/`eq` imports for now-unused as in Step 1.

- [ ] **Step 3: addon.service.ts — replace the create block**

Find (around L174–196):

```ts
    // 3.5 Get or create Stripe price for this addon
    let stripePriceId = addonPrice.stripePriceId;
    if (!stripePriceId) {
      this.logger.log(
        `Creating Stripe price for add-on ${addonType} on plan ${sub.planCode}`,
      );
      stripePriceId = await this.stripeService.getOrCreatePriceForAddon({
        addonType,
        planCode: sub.planCode,
        priceCents: addonPrice.pricePerUnitCents,
        interval: 'month',
      });

      // Update the addon_pricing record with the new Stripe price ID
      await db
        .update(addonPricing)
        .set({ stripePriceId })
        .where(eq(addonPricing.id, addonPrice.id));

      this.logger.log(
        `Created Stripe price ${stripePriceId} for add-on ${addonType}`,
      );
    }
```

Replace with:

```ts
    // 3.5 Read the provisioned Stripe price for this addon (read-only — prices
    //     are provisioned out-of-band by the stripe-provision script).
    const stripePriceId = addonPrice.stripePriceId;
    if (!stripePriceId) {
      throw new BadRequestException(
        `Add-on "${addonType}" for plan "${sub.planCode}" is not provisioned in Stripe — run the pricing provision script (npx ts-node src/drizzle/seeds/stripe-provision.ts)`,
      );
    }
```

> `addonPricing`/`eq`/`db` may still be used elsewhere in this file — check before removing any import. Only remove what is genuinely unused.

- [ ] **Step 4: Verify build + lint**

Run: `npm run build`
Expected: succeeds (no type errors).

Run: `npm run lint`
Expected: no new errors; fix any "unused import/variable" the changes introduced (remove dead `plans`/`eq` imports flagged above).

- [ ] **Step 5: Commit**

```bash
git add src/billing/services/subscription.service.ts src/billing/services/plan-change.service.ts src/billing/services/addon.service.ts
git commit -m "feat(billing): read-only checkout — read provisioned price or throw"
```

---

## Task 5: Remove dead price-creation methods from `StripeService`

**Files:**
- Modify: `src/stripe/stripe.service.ts` (remove `getOrCreatePriceForPlan` ~L544–601, `getOrCreatePriceForAddon` ~L607–674, `getAddonDisplayName` ~L676–683)

After Task 4 these three have zero callers (grep across `src/` confirms only the 3 services called them, now read-only).

- [ ] **Step 1: Confirm zero callers**

Run: `grep -rn "getOrCreatePriceForPlan\|getOrCreatePriceForAddon\|getAddonDisplayName" src/`
Expected: only matches inside `src/stripe/stripe.service.ts` itself (the definitions). If any other file references them, STOP — Task 4 missed a call site; fix that first.

- [ ] **Step 2: Delete the three methods**

Remove the full bodies of `getOrCreatePriceForPlan`, `getOrCreatePriceForAddon`, and the private `getAddonDisplayName` from `src/stripe/stripe.service.ts` (the contiguous block ~L540–683, including their doc comments). Leave the surrounding methods (`getCustomer` above, `attachPaymentMethod` below) intact.

- [ ] **Step 3: Verify build + lint**

Run: `npm run build`
Expected: succeeds.

Run: `npm run lint`
Expected: no errors. If Stripe SDK imports/types used only by the deleted methods are now unused, remove them.

- [ ] **Step 4: Commit**

```bash
git add src/stripe/stripe.service.ts
git commit -m "refactor(billing): remove dead runtime price-creation methods"
```

---

## Task 6: Super-admin pricing runbook + final verify

**Files:**
- Modify: `docs/super-admin-api.md`

- [ ] **Step 1: Confirm the doc exists and find a heading anchor**

Run: `ls docs/super-admin-api.md && grep -n '^#' docs/super-admin-api.md | head -30`
Expected: the file exists; you get a list of section headings. Append the new section at the end of the document (or in a logical "Operations" area if one exists).

> If `docs/super-admin-api.md` does **not** exist, create it with a top-level `# Super Admin API` heading, then add the section below.

- [ ] **Step 2: Add the "Pricing & Stripe Operations" section**

Append to `docs/super-admin-api.md`:

```markdown
## Pricing & Stripe Operations

Billing prices are **provisioned**, not created at runtime. The app reads the
stored `stripePriceId` at checkout and throws if a paid plan/addon is not
provisioned. Stripe Prices are immutable; identity is the stable `lookup_key`
(`plan_<code>_monthly`, `addon_<type>_<plan>`).

### Provisioning (first-time setup, or new Stripe account/mode)

1. Seed plans/addons: `npx ts-node src/drizzle/seeds/plans.seed.ts`
2. Provision Stripe prices into the account/mode that `STRIPE_SECRET_KEY`
   points at: `npx ts-node src/drizzle/seeds/stripe-provision.ts`
   - The script prints the **account id + TEST/LIVE mode** before writing —
     confirm it is the intended account.
   - It is idempotent: it keys off whether a price with each `lookup_key`
     already exists **in that account**, not off DB state. Re-running is safe.
3. **Switching Stripe accounts** (e.g. old test account → new live account):
   set `STRIPE_SECRET_KEY` to the new account's key and re-run step 2. The new
   account has no matching lookup_keys, so fresh prices are created there and
   the DB `stripePriceId` columns are overwritten. Run once per mode (test key,
   then live key).

### Changing a plan or addon price (prices are immutable)

1. **Never** edit a Stripe price amount in the dashboard, and **never** create
   prices at runtime — only via the provision script.
2. To change a price (e.g. PRO $10 → $12):
   - Update the amount in the DB (`plans.base_price_cents` or
     `addon_pricing.price_per_unit_cents`). Keep the seed file in sync so a
     fresh DB matches.
   - Run `stripe-provision.ts`. It takes the **reprice path**: creates a new
     Stripe Price with the new amount, runs `transfer_lookup_key=true` to move
     the stable key onto it, **deactivates** the old price, and updates the DB
     `stripe_price_id` to the new id.
3. **Existing subscribers keep their old price** (their Stripe subscription
   still references the old price id) until explicitly migrated; **new**
   checkouts use the new price automatically.
4. (Optional) Migrate existing subscribers via a Stripe subscription update with
   your chosen proration behavior.
5. Do this in **both** test and live modes (run the script with each mode's key).
6. Display amounts (`base_price_cents` / `price_per_unit_cents`) mirror the
   Stripe price — after any change the DB and Stripe must agree; the provision
   script keeps them in sync.
```

- [ ] **Step 3: Commit**

```bash
git add docs/super-admin-api.md
git commit -m "docs(super-admin): pricing & Stripe provisioning runbook"
```

- [ ] **Step 4: Final whole-branch verify**

Run: `npm run build` → expected: succeeds.
Run: `npm run lint` → expected: clean.
Run: `npx jest src/stripe/price-provisioning.spec.ts` → expected: all pass.

---

## Out of scope (YAGNI)

- Running the provision script against a real Stripe account (operator/cutover step, not code).
- Annual prices, coupons, tax, proration automation, Stripe Entitlements.
- Frontend changes (it consumes the API; price ids are server-side).
- Migrating existing subscribers between prices (no subscribers on the fresh DB).

## Risks

- **Run-order:** `stripe-provision` MUST run before any paid checkout, else read-only checkout throws a clear "not provisioned" error. Documented in the runbook.
- **Wrong key (test vs live):** the script echoes account id + mode before writing.
- **Mid-creation interruption:** if the script dies between `products.create` and `prices.create`, a re-run could leave one empty product (no price/lookup_key). Harmless; archive manually. Primary idempotency is the lookup_key price check, which short-circuits on any successful prior run.
- **Unused-import churn:** removing runtime creation may orphan `plans`/`eq` imports in the billing services and Stripe types in `stripe.service.ts`. Tasks 4–5 explicitly check and clean these; `npm run lint` is the gate.
