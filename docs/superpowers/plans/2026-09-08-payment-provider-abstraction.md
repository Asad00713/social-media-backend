# Payment Provider Abstraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every billing operation run through the account's own payment provider, so a Lemon Squeezy customer can never silently take a Stripe code path.

**Architecture:** One `PaymentProviderAdapter` interface modelled on intent (never on Stripe's shape), with a Stripe adapter wrapping the existing `StripeService` and a Lemon Squeezy adapter that fans a single logical operation out across N provider subscriptions. A `ProviderRegistry` resolves which adapter an account uses. Three guard layers stop Stripe code from running for a non-Stripe account: a runtime assertion, an architecture test, and separate webhook routes.

**Tech Stack:** NestJS, Drizzle ORM, PostgreSQL, Jest (ts-jest, transpile-only), Lemon Squeezy REST API (JSON:API), Stripe SDK.

**Spec:** `docs/superpowers/specs/2026-09-08-payment-provider-abstraction-design.md`

## Global Constraints

- **NEVER run `npm run lint`.** It is a repo-wide `eslint --fix` that once rewrote 132 unrelated files and stripped type casts in `auth.service.ts`. Lint only explicit paths: `npx eslint <file> <file>`.
- **NEVER run `npm run db:generate`, `npm run db:migrate`, or `npm run db:push`.** The migration journal has drifted. Migrations are hand-written and applied manually.
- **Tests must assert RUNTIME values, never types.** `isolatedModules: true` means ts-jest transpiles without type-checking, so a type-annotation-only test asserts nothing.
- **Baseline is 4 pre-existing test failures** (`billing.controller.spec`, `evergreen.service.spec`, `pool-config.spec`, `price-provisioning.spec`) and **21 pre-existing tsc errors**. Do not report these as new; do not "fix" them.
- **`nest build` passing is NOT proof the app boots.** A DI cycle passes the build and fails at runtime. After any module edit, verify with:
  `npx ts-node -r tsconfig-paths/register --transpile-only boot-check.ts` (expects `BOOT_OK`).
- **Never read `providerQuantity` for an access decision.** `subscription_items.quantity` is the entitlement; `provider_subscriptions.provider_quantity` is what the provider bills. They diverge legitimately.
- **Lemon Squeezy `cancelled` does NOT revoke access** — only `expired` does. Mapping it onto our `canceled` cuts off paying customers.
- Existing helpers to reuse, not reimplement: `src/billing/services/provider-subscription.util.ts` (`pickDefaultProvider`, `findItem`, `isLive`, `rowsForProvider`, `hasLegacyProvider`, `billedQuantities`).

---

## File Structure

**Create:**
- `src/billing/providers/payment-provider.interface.ts` — the interface + result types
- `src/billing/providers/provider-registry.service.ts` — resolves an account's adapter
- `src/billing/providers/stripe.adapter.ts` — wraps existing `StripeService`
- `src/billing/providers/lemonsqueezy.client.ts` — thin HTTP client (auth, JSON:API, errors)
- `src/billing/providers/lemonsqueezy.adapter.ts` — the fan-out adapter
- `src/billing/providers/lemonsqueezy-status.util.ts` — status mapping (pure)
- `src/billing/providers/catalogue.service.ts` — plan/add-on → provider price or variant id
- `src/billing/services/lemonsqueezy-webhook.service.ts` — LS event handling
- `drizzle/migrations/0033_provider_price_ids.sql` — per-provider price ids

**Modify:**
- `src/drizzle/schema/billing.schema.ts` — add `provider_prices` table
- `src/billing/billing.module.ts` — register the new providers
- `src/billing/billing.controller.ts` — add `/webhooks/lemonsqueezy`, `/billing/portal`
- `src/stripe/stripe.service.ts` — add the guard assertion
- `src/billing/services/subscription.service.ts:62,419` — route through the registry

---

### Task 1: The interface and result types

Pure types plus one small pure function. No DB, no HTTP.

**Files:**
- Create: `src/billing/providers/payment-provider.interface.ts`
- Test: `src/billing/providers/payment-provider.interface.spec.ts`

**Interfaces:**
- Consumes: `PaymentProvider`, `ProviderItemType` from `src/drizzle/schema` (already exported).
- Produces: `PaymentProviderAdapter` (interface), `PurchaseResult` (discriminated union), `isCheckoutRequired(r: PurchaseResult): boolean`, `PROVIDER_ITEM_ORDER: ProviderItemType[]`.

- [ ] **Step 1: Write the failing test**

```ts
// src/billing/providers/payment-provider.interface.spec.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/billing/providers/payment-provider.interface.spec.ts`
Expected: FAIL — `Cannot find module './payment-provider.interface'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/billing/providers/payment-provider.interface.ts
import { PaymentProvider, ProviderItemType } from '../../drizzle/schema';

/**
 * Buying an add-on does not mean the same thing at every provider.
 *
 * Stripe adds an item to the existing subscription and invoices immediately,
 * so the purchase is finished when the call returns. Lemon Squeezy has no
 * endpoint that creates a subscription — `POST /v1/subscription-items` does
 * not exist — so a NEW add-on can only start at a hosted checkout, and
 * finishes later via webhook.
 *
 * A discriminated union rather than a nullable url: callers must branch, so
 * the redirect case cannot be forgotten.
 */
export type PurchaseResult =
  | { status: 'completed'; quantity: number }
  | { status: 'checkout_required'; url: string };

export function isCheckoutRequired(
  result: PurchaseResult,
): result is { status: 'checkout_required'; url: string } {
  return result.status === 'checkout_required';
}

/**
 * The order to act on a subscription's parts when an operation must touch all
 * of them (cancel, or a provider migration).
 *
 * BASE_PLAN is LAST on purpose. A Lemon Squeezy cancel is N API calls, and if
 * the sequence breaks midway the customer must still hold the plan that runs
 * their service. Cancelling the base plan first and failing afterwards would
 * end their access while the add-ons carried on billing — the worst reachable
 * state.
 */
export const PROVIDER_ITEM_ORDER: ProviderItemType[] = [
  'EXTRA_CHANNEL',
  'EXTRA_MEMBER',
  'EXTRA_WORKSPACE',
  'EXTRA_AI_TOKENS',
  'BASE_PLAN',
];

/**
 * One account's payment provider, expressed as INTENT.
 *
 * Deliberately no method takes or returns a provider id. Callers pass our own
 * `subscriptionId` plus an `itemType`; the adapter looks up its own
 * `provider_subscriptions` rows. A leaked `subscriptionItemId` would make the
 * Lemon Squeezy adapter unwritable — it has no single item to name, because
 * each add-on is a separate subscription there.
 */
export interface PaymentProviderAdapter {
  readonly name: PaymentProvider;

  /** Hosted checkout for a new paid subscription. */
  createCheckout(
    userId: string,
    planCode: string,
    workspaceId: string,
  ): Promise<{ url: string }>;

  changePlan(subscriptionId: number, newPlanCode: string): Promise<void>;

  purchaseAddon(
    subscriptionId: number,
    itemType: ProviderItemType,
    quantity: number,
  ): Promise<PurchaseResult>;

  changeAddonQuantity(
    subscriptionId: number,
    itemType: ProviderItemType,
    quantity: number,
  ): Promise<void>;

  removeAddon(
    subscriptionId: number,
    itemType: ProviderItemType,
  ): Promise<void>;

  pause(subscriptionId: number): Promise<void>;
  resume(subscriptionId: number): Promise<void>;
  cancel(subscriptionId: number, atPeriodEnd: boolean): Promise<void>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/billing/providers/payment-provider.interface.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Verify tsc is unchanged**

Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: `21`

- [ ] **Step 6: Commit**

```bash
git add src/billing/providers/payment-provider.interface.ts src/billing/providers/payment-provider.interface.spec.ts
git commit -m "feat(billing): the payment provider interface, modelled on intent"
```

---

### Task 2: Status mapping

Pure functions. This is where the trap that would cut off paying customers lives, so it is isolated and tested on its own.

**Files:**
- Create: `src/billing/providers/lemonsqueezy-status.util.ts`
- Test: `src/billing/providers/lemonsqueezy-status.util.spec.ts`

**Interfaces:**
- Produces: `mapLemonSqueezyStatus(lsStatus: string): { status: string; cancelAtPeriodEnd: boolean }`, `LS_STATUS_REVOKES_ACCESS: string[]`.

- [ ] **Step 1: Write the failing test**

```ts
// src/billing/providers/lemonsqueezy-status.util.spec.ts
import { mapLemonSqueezyStatus } from './lemonsqueezy-status.util';

describe('mapLemonSqueezyStatus', () => {
  it('maps on_trial to trialing', () => {
    expect(mapLemonSqueezyStatus('on_trial')).toEqual({
      status: 'trialing',
      cancelAtPeriodEnd: false,
    });
  });

  it('maps active to active', () => {
    expect(mapLemonSqueezyStatus('active')).toEqual({
      status: 'active',
      cancelAtPeriodEnd: false,
    });
  });

  it('maps paused to paused', () => {
    expect(mapLemonSqueezyStatus('paused')).toEqual({
      status: 'paused',
      cancelAtPeriodEnd: false,
    });
  });

  it('maps past_due to past_due — dunning is still retrying', () => {
    expect(mapLemonSqueezyStatus('past_due')).toEqual({
      status: 'past_due',
      cancelAtPeriodEnd: false,
    });
  });

  // `unpaid` has no equivalent in our enum, and with store dunning disabled a
  // subscription can sit there indefinitely. Folding it into past_due keeps
  // access on while the payment problem is chased.
  it('folds unpaid into past_due', () => {
    expect(mapLemonSqueezyStatus('unpaid')).toEqual({
      status: 'past_due',
      cancelAtPeriodEnd: false,
    });
  });

  // THE TRAP. Lemon Squeezy's `cancelled` means the customer KEEPS access
  // until ends_at; only `expired` revokes. Mapping it to our `canceled` would
  // cut off a paying customer the moment they schedule a cancellation.
  it('maps cancelled to ACTIVE with cancelAtPeriodEnd, not canceled', () => {
    expect(mapLemonSqueezyStatus('cancelled')).toEqual({
      status: 'active',
      cancelAtPeriodEnd: true,
    });
  });

  it('maps expired to canceled — the only status that revokes', () => {
    expect(mapLemonSqueezyStatus('expired')).toEqual({
      status: 'canceled',
      cancelAtPeriodEnd: false,
    });
  });

  // Fail open: an unrecognised status must not lock a paying customer out.
  it('treats an unknown status as active rather than locking anyone out', () => {
    expect(mapLemonSqueezyStatus('something_new')).toEqual({
      status: 'active',
      cancelAtPeriodEnd: false,
    });
  });

  it('is case-insensitive', () => {
    expect(mapLemonSqueezyStatus('CANCELLED').cancelAtPeriodEnd).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/billing/providers/lemonsqueezy-status.util.spec.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
// src/billing/providers/lemonsqueezy-status.util.ts

/**
 * Lemon Squeezy subscription statuses, translated to ours.
 *
 * The one that matters is `cancelled`. Lemon Squeezy's docs are explicit that
 * customers keep access in every status EXCEPT `expired` — a `cancelled`
 * subscription runs to `ends_at` and only then expires. Verified live on
 * 2026-09-07: DELETE returned `status: cancelled` with `ends_at` a month out.
 *
 * So `cancelled` maps to our `active` plus `cancelAtPeriodEnd`, which is what
 * our own model already means by "cancelled but still paid up". Mapping the
 * word onto our `canceled` would revoke access the moment a customer
 * scheduled a cancellation.
 */
export const LS_STATUS_REVOKES_ACCESS = ['expired'];

export function mapLemonSqueezyStatus(lsStatus: string): {
  status: string;
  cancelAtPeriodEnd: boolean;
} {
  switch ((lsStatus ?? '').toLowerCase()) {
    case 'on_trial':
      return { status: 'trialing', cancelAtPeriodEnd: false };
    case 'paused':
      return { status: 'paused', cancelAtPeriodEnd: false };
    case 'past_due':
    case 'unpaid':
      return { status: 'past_due', cancelAtPeriodEnd: false };
    case 'cancelled':
      return { status: 'active', cancelAtPeriodEnd: true };
    case 'expired':
      return { status: 'canceled', cancelAtPeriodEnd: false };
    case 'active':
    default:
      // Fail open. An unrecognised status must not lock out someone paying.
      return { status: 'active', cancelAtPeriodEnd: false };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/billing/providers/lemonsqueezy-status.util.spec.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Mutation-test the trap**

Temporarily change the `cancelled` case to `return { status: 'canceled', cancelAtPeriodEnd: false };` and re-run. Expected: the `cancelled` test FAILS. Restore, re-run, expect PASS. This proves the test would catch the regression rather than merely passing today.

- [ ] **Step 6: Commit**

```bash
git add src/billing/providers/lemonsqueezy-status.util.ts src/billing/providers/lemonsqueezy-status.util.spec.ts
git commit -m "feat(billing): map Lemon Squeezy statuses without revoking paid access"
```

---

### Task 3: Per-provider price ids (schema + migration)

`addon_pricing.stripe_price_id` is **NOT NULL** and `plans.stripe_price_id` is Stripe-shaped. Lemon Squeezy needs variant ids in the same role. Adding `lemonsqueezy_variant_id` columns beside them would repeat the mistake for every future provider, so this adds one table.

**Files:**
- Modify: `src/drizzle/schema/billing.schema.ts`
- Create: `drizzle/migrations/0033_provider_prices.sql`
- Test: `src/billing/providers/catalogue.service.spec.ts` (written in Task 4)

**Interfaces:**
- Produces: `providerPrices` table + `ProviderPrice` / `NewProviderPrice` types, exported from `src/drizzle/schema`.

- [ ] **Step 1: Add the table to the schema**

Insert after `providerSubscriptions` in `src/drizzle/schema/billing.schema.ts`:

```ts
/**
 * What a plan or add-on is called at each payment provider.
 *
 * `plans.stripe_price_id` and `addon_pricing.stripe_price_id` name Stripe
 * specifically, and the latter is NOT NULL — so they cannot answer "what is
 * the Pro plan at Lemon Squeezy?". Adding a `lemonsqueezy_variant_id` beside
 * each would repeat the problem for the provider after that.
 *
 * `providerRef` holds a Stripe price id (`price_...`) or a Lemon Squeezy
 * variant id, whichever this provider uses to name the thing being sold.
 */
export const providerPrices = pgTable(
  'provider_prices',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    provider: varchar('provider', { length: 20 }).notNull(),
    /** Plan code (FREE/BASIC/PRO/MAX) for a plan, or NULL for an add-on. */
    planCode: varchar('plan_code', { length: 20 }),
    /** BASE_PLAN, or an add-on type. Mirrors provider_subscriptions.item_type. */
    itemType: varchar('item_type', { length: 30 }).notNull(),
    /** Stripe price id, or Lemon Squeezy variant id. */
    providerRef: varchar('provider_ref', { length: 255 }).notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => {
    return {
      uniqueProviderPrice: unique().on(
        table.provider,
        table.planCode,
        table.itemType,
      ),
    };
  },
);
```

And with the other type exports:

```ts
export type ProviderPrice = typeof providerPrices.$inferSelect;
export type NewProviderPrice = typeof providerPrices.$inferInsert;
```

- [ ] **Step 2: Write the migration**

```sql
-- drizzle/migrations/0033_provider_prices.sql
--
-- What a plan or add-on is called at each payment provider.
--
-- plans.stripe_price_id and addon_pricing.stripe_price_id name Stripe
-- specifically, and the latter is NOT NULL, so neither can answer "what is the
-- Pro plan at Lemon Squeezy?". Adding a lemonsqueezy_variant_id column beside
-- each would repeat the problem for the next provider.
--
-- provider_ref holds a Stripe price id or a Lemon Squeezy variant id.
--
-- Apply AFTER 0032. Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS provider_prices (
  id            bigserial PRIMARY KEY,
  provider      varchar(20) NOT NULL,
  plan_code     varchar(20),
  item_type     varchar(30) NOT NULL,
  provider_ref  varchar(255) NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamp NOT NULL DEFAULT now(),
  updated_at    timestamp NOT NULL DEFAULT now()
);

-- Name kept under 63 characters; Postgres silently truncates longer
-- identifiers, which would leave the DROP matching nothing on a re-run.
ALTER TABLE provider_prices
  DROP CONSTRAINT IF EXISTS provider_prices_provider_plan_item_unique;
ALTER TABLE provider_prices
  ADD CONSTRAINT provider_prices_provider_plan_item_unique
  UNIQUE (provider, plan_code, item_type);

CREATE INDEX IF NOT EXISTS provider_prices_lookup_idx
  ON provider_prices (provider, item_type);

COMMIT;
```

- [ ] **Step 3: Verify the migration runs on a real Postgres**

```bash
docker run -d --rm --name pp_test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=testdb -p 55434:5432 postgres:16-alpine
sleep 3
docker exec -i pp_test psql -U postgres -d testdb -v ON_ERROR_STOP=1 -q < drizzle/migrations/0033_provider_prices.sql
echo "run 1 exit=$?"
docker exec -i pp_test psql -U postgres -d testdb -v ON_ERROR_STOP=1 -q < drizzle/migrations/0033_provider_prices.sql
echo "run 2 (idempotency) exit=$?"
docker exec -i pp_test psql -U postgres -d testdb -tAc "SELECT conname, length(conname) FROM pg_constraint WHERE conrelid='provider_prices'::regclass AND contype='u'"
docker stop pp_test
```

Expected: both runs `exit=0`; the constraint name printed with length < 63.

- [ ] **Step 4: Verify tsc**

Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: `21`

- [ ] **Step 5: Commit**

```bash
git add src/drizzle/schema/billing.schema.ts drizzle/migrations/0033_provider_prices.sql
git commit -m "feat(billing): name plans and add-ons per provider"
```

---

### Task 4: Catalogue service

Answers "what is this plan/add-on called at this provider?", falling back to the existing Stripe columns so nothing breaks before `provider_prices` is populated.

**Files:**
- Create: `src/billing/providers/catalogue.service.ts`
- Test: `src/billing/providers/catalogue.service.spec.ts`

**Interfaces:**
- Consumes: `providerPrices`, `plans`, `addonPricing` from `src/drizzle/schema`; `PaymentProvider`, `ProviderItemType`.
- Produces: `CatalogueService` with `resolveRef(provider: PaymentProvider, planCode: string, itemType: ProviderItemType): Promise<string>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/billing/providers/catalogue.service.spec.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/billing/providers/catalogue.service.spec.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
// src/billing/providers/catalogue.service.ts
import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { DbType } from '../../drizzle/db';
import {
  providerPrices,
  plans,
  addonPricing,
  PaymentProvider,
  ProviderItemType,
} from '../../drizzle/schema';

/**
 * What a plan or add-on is called at a given provider.
 *
 * Stripe reads fall back to the legacy `plans.stripe_price_id` /
 * `addon_pricing.stripe_price_id` columns, so live Stripe billing keeps
 * working before `provider_prices` is populated.
 *
 * Lemon Squeezy has NO fallback on purpose. Those legacy columns hold Stripe
 * price ids; handing one to Lemon Squeezy would fail deep inside their API
 * with an error that says nothing useful. Failing here names the missing row.
 */
@Injectable()
export class CatalogueService {
  constructor(@Inject(DRIZZLE) private db: DbType) {}

  async resolveRef(
    provider: PaymentProvider,
    planCode: string,
    itemType: ProviderItemType,
  ): Promise<string> {
    const rows = await this.db
      .select({ providerRef: providerPrices.providerRef })
      .from(providerPrices)
      .where(
        and(
          eq(providerPrices.provider, provider),
          eq(providerPrices.itemType, itemType),
          eq(providerPrices.planCode, planCode),
          eq(providerPrices.isActive, true),
        ),
      )
      .limit(1);

    const ref = rows[0]?.providerRef;
    if (ref) return ref;

    if (provider === 'stripe') {
      const legacy = await this.legacyStripeRef(planCode, itemType);
      if (legacy) return legacy;
    }

    throw new BadRequestException(
      `No ${provider} price is provisioned for ${planCode} / ${itemType}. ` +
        `Add a provider_prices row for it.`,
    );
  }

  private async legacyStripeRef(
    planCode: string,
    itemType: ProviderItemType,
  ): Promise<string | null> {
    if (itemType === 'BASE_PLAN') {
      const rows = await this.db
        .select({ stripePriceId: plans.stripePriceId })
        .from(plans)
        .where(eq(plans.code, planCode))
        .limit(1);
      return rows[0]?.stripePriceId ?? null;
    }

    const rows = await this.db
      .select({ stripePriceId: addonPricing.stripePriceId })
      .from(addonPricing)
      .where(
        and(
          eq(addonPricing.planCode, planCode),
          eq(addonPricing.addonType, itemType),
        ),
      )
      .limit(1);
    return rows[0]?.stripePriceId ?? null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/billing/providers/catalogue.service.spec.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/billing/providers/catalogue.service.ts src/billing/providers/catalogue.service.spec.ts
git commit -m "feat(billing): resolve a plan or add-on to its provider price"
```

---

### Task 5: Provider registry

Decides which adapter an account uses. This is the single door referred to throughout the spec.

**Files:**
- Create: `src/billing/providers/provider-registry.service.ts`
- Test: `src/billing/providers/provider-registry.service.spec.ts`

**Interfaces:**
- Consumes: `providerSubscriptions`, `subscriptions`, `PaymentProvider`; `pickDefaultProvider` from `../services/provider-subscription.util`.
- Produces: `ProviderRegistryService` with
  `defaultProviderFor(subscriptionId: number): Promise<PaymentProvider | null>`,
  `providerForUser(userId: string): Promise<PaymentProvider>`,
  `configuredProvider(): PaymentProvider`.

- [ ] **Step 1: Write the failing test**

```ts
// src/billing/providers/provider-registry.service.spec.ts
import { ProviderRegistryService } from './provider-registry.service';

function makeDb(rows: Record<string, unknown>[]) {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(rows),
        }),
        where: jest.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

describe('ProviderRegistryService.configuredProvider', () => {
  const OLD = process.env.BILLING_PROVIDER;
  afterEach(() => {
    process.env.BILLING_PROVIDER = OLD;
  });

  it('reads BILLING_PROVIDER', () => {
    process.env.BILLING_PROVIDER = 'stripe';
    const svc = new ProviderRegistryService(makeDb([]) as never);
    expect(svc.configuredProvider()).toBe('stripe');
  });

  it('defaults to lemonsqueezy when unset', () => {
    delete process.env.BILLING_PROVIDER;
    const svc = new ProviderRegistryService(makeDb([]) as never);
    expect(svc.configuredProvider()).toBe('lemonsqueezy');
  });

  // A typo must not silently route real money somewhere unintended.
  it('throws on an unrecognised value rather than guessing', () => {
    process.env.BILLING_PROVIDER = 'strpe';
    const svc = new ProviderRegistryService(makeDb([]) as never);
    expect(() => svc.configuredProvider()).toThrow(/strpe/);
  });
});

describe('ProviderRegistryService.providerForUser', () => {
  it('uses the account’s own default row, not the env var', async () => {
    process.env.BILLING_PROVIDER = 'stripe';
    const db = makeDb([{ provider: 'lemonsqueezy', isDefault: true }]);
    const svc = new ProviderRegistryService(db as never);
    // An existing customer must never change provider implicitly.
    await expect(svc.providerForUser('user-1')).resolves.toBe('lemonsqueezy');
  });

  it('falls back to the configured provider for a brand-new account', async () => {
    process.env.BILLING_PROVIDER = 'lemonsqueezy';
    const svc = new ProviderRegistryService(makeDb([]) as never);
    await expect(svc.providerForUser('user-new')).resolves.toBe('lemonsqueezy');
  });

  // Falling back to Stripe here would reintroduce exactly the silent-Stripe
  // problem this whole design exists to prevent.
  it('does NOT hardcode stripe as the fallback', async () => {
    process.env.BILLING_PROVIDER = 'lemonsqueezy';
    const svc = new ProviderRegistryService(makeDb([]) as never);
    await expect(svc.providerForUser('user-new')).resolves.not.toBe('stripe');
  });
});

describe('ProviderRegistryService.defaultProviderFor', () => {
  it('returns the default provider for a subscription', async () => {
    const db = makeDb([{ provider: 'lemonsqueezy', isDefault: true }]);
    const svc = new ProviderRegistryService(db as never);
    await expect(svc.defaultProviderFor(1)).resolves.toBe('lemonsqueezy');
  });

  // Null, not a guess: the guard uses this, and a guess would either block a
  // legitimate call or wave through the one it exists to catch.
  it('returns null when the subscription has no provider rows', async () => {
    const svc = new ProviderRegistryService(makeDb([]) as never);
    await expect(svc.defaultProviderFor(1)).resolves.toBeNull();
  });

  it('ignores non-default rows during a migration window', async () => {
    const db = makeDb([
      { provider: 'lemonsqueezy', isDefault: false },
      { provider: 'stripe', isDefault: true },
    ]);
    const svc = new ProviderRegistryService(db as never);
    await expect(svc.defaultProviderFor(1)).resolves.toBe('stripe');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/billing/providers/provider-registry.service.spec.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
// src/billing/providers/provider-registry.service.ts
import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { DbType } from '../../drizzle/db';
import {
  providerSubscriptions,
  subscriptions,
  PaymentProvider,
  PAYMENT_PROVIDERS,
} from '../../drizzle/schema';
import { pickDefaultProvider } from '../services/provider-subscription.util';

/**
 * Which payment provider an account bills through.
 *
 * One rule, in one place: an EXISTING customer's own `is_default` row decides,
 * and only a brand-new account falls back to the configured default. That is
 * what makes the Lemon Squeezy -> Stripe migration safe — flipping the env var
 * sends new signups to Stripe without moving anybody who is mid-period.
 */
@Injectable()
export class ProviderRegistryService {
  constructor(@Inject(DRIZZLE) private db: DbType) {}

  /**
   * The provider new accounts are signed up with.
   *
   * NOT defaulted to Stripe. Hardcoding Stripe would reintroduce the silent-
   * Stripe problem this design exists to prevent: any account whose provider
   * row failed to write would quietly bill through Stripe.
   */
  configuredProvider(): PaymentProvider {
    const raw = process.env.BILLING_PROVIDER ?? 'lemonsqueezy';
    if (!(PAYMENT_PROVIDERS as readonly string[]).includes(raw)) {
      throw new InternalServerErrorException(
        `BILLING_PROVIDER is "${raw}", which is not a known provider ` +
          `(${PAYMENT_PROVIDERS.join(', ')}).`,
      );
    }
    return raw as PaymentProvider;
  }

  /** The provider billing one of our subscriptions, or null if it has none. */
  async defaultProviderFor(
    subscriptionId: number,
  ): Promise<PaymentProvider | null> {
    const rows = await this.db
      .select()
      .from(providerSubscriptions)
      .where(eq(providerSubscriptions.subscriptionId, subscriptionId));
    return pickDefaultProvider(rows as never);
  }

  /** The provider billing an account, falling back for a new one. */
  async providerForUser(userId: string): Promise<PaymentProvider> {
    const rows = await this.db
      .select({
        provider: providerSubscriptions.provider,
        isDefault: providerSubscriptions.isDefault,
      })
      .from(providerSubscriptions)
      .innerJoin(
        subscriptions,
        eq(subscriptions.id, providerSubscriptions.subscriptionId),
      )
      .where(eq(subscriptions.userId, userId));

    return pickDefaultProvider(rows as never) ?? this.configuredProvider();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/billing/providers/provider-registry.service.spec.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Register in the module and verify the app still boots**

In `src/billing/billing.module.ts`, import `ProviderRegistryService` and `CatalogueService`, and add both to `providers` and `exports`.

```bash
npx nest build
cp /tmp/boot.ts ./boot-check.ts 2>/dev/null || cat > boot-check.ts <<'EOF'
import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
NestFactory.createApplicationContext(AppModule, { logger: false })
  .then(async (a) => { console.log('BOOT_OK'); await a.close(); process.exit(0); })
  .catch((e) => { console.error('BOOT_FAIL:', e.message); process.exit(1); });
EOF
npx ts-node -r tsconfig-paths/register --transpile-only boot-check.ts
rm -f boot-check.ts
```

Expected: `BOOT_OK`

- [ ] **Step 6: Commit**

```bash
git add src/billing/providers/provider-registry.service.ts src/billing/providers/provider-registry.service.spec.ts src/billing/billing.module.ts
git commit -m "feat(billing): resolve an account's payment provider in one place"
```

---

### Task 6: The Stripe guard

Layer 1 of leak prevention. Converts a silent wrong-provider call into a loud failure.

**Files:**
- Create: `src/stripe/stripe-guard.util.ts`
- Test: `src/stripe/stripe.guard.spec.ts`

**Interfaces:**
- Consumes: `PaymentProvider` from `src/drizzle/schema`. Nothing else — see below.
- Produces: `assertProviderIsStripe(provider: PaymentProvider | null, subscriptionId: number): void`.

**Why a free function rather than a method on `StripeService`:** making
`StripeService` call `ProviderRegistryService` itself would need
`StripeModule` to import `BillingModule`, which already imports `StripeModule`
— a cycle needing `forwardRef` on both sides. That is exactly the shape that
passed `nest build` and failed at runtime earlier on this branch. A pure
function takes the already-resolved provider as an argument instead, so the
Stripe adapter (which has the registry) does the lookup and passes the answer
in. No new module edge, nothing to boot-check.

- [ ] **Step 1: Write the failing test**

```ts
// src/stripe/stripe.guard.spec.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/stripe/stripe.guard.spec.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
// src/stripe/stripe-guard.util.ts
import { InternalServerErrorException } from '@nestjs/common';
import { PaymentProvider } from '../drizzle/schema';

/**
 * Refuse a Stripe call aimed at a subscription Stripe does not bill.
 *
 * This exists because the failure mode is SILENCE. Today every one of the 39
 * Stripe call sites runs unconditionally; a Stripe call on a Lemon Squeezy
 * customer does not throw, it succeeds — charging the wrong place or writing
 * the wrong id — and is found weeks later as a billing discrepancy.
 *
 * Throwing turns that into an immediate, traceable 500, usually in testing.
 *
 * A null provider is ALLOWED: a subscription with no provider rows is
 * mid-creation, and that is precisely the Stripe signup path which creates the
 * first row. Blocking it would break the flow this guard protects.
 */
export function assertProviderIsStripe(
  provider: PaymentProvider | null,
  subscriptionId: number,
): void {
  if (provider && provider !== 'stripe') {
    throw new InternalServerErrorException(
      `Stripe call attempted for subscription ${subscriptionId}, which is ` +
        `billed by ${provider}. This is a provider-routing bug.`,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/stripe/stripe.guard.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/stripe/stripe-guard.util.ts src/stripe/stripe.guard.spec.ts
git commit -m "feat(billing): refuse Stripe calls aimed at another provider"
```

---

### Task 7: Architecture test

Layer 2. Protects future work, including changes made long after this plan.

**Files:**
- Create: `src/billing/providers/provider-isolation.spec.ts`

**Interfaces:**
- Consumes: nothing at runtime; reads the source tree with `fs`.

- [ ] **Step 1: Write the test**

```ts
// src/billing/providers/provider-isolation.spec.ts
import * as fs from 'fs';
import * as path from 'path';

/**
 * Provider-specific calls must stay inside the adapters.
 *
 * This is the layer that protects work done long after the abstraction was
 * built. A new feature that reaches for `stripeService.something` in a service
 * would compile, pass its own tests, and silently bill Lemon Squeezy customers
 * through Stripe. This test fails instead.
 */

const SRC = path.join(__dirname, '..', '..');

/** Files allowed to name a provider directly. */
const ALLOWED = [
  path.join('billing', 'providers'),
  path.join('stripe', 'stripe.service.ts'),
  path.join('stripe', 'stripe.module.ts'),
  path.join('stripe', 'stripe-guard.util.ts'),
  // Webhook + invoice services still speak Stripe's payload types; they are
  // migrated in a later effort and are listed here so the boundary is explicit
  // rather than accidental.
  path.join('billing', 'services', 'webhook.service.ts'),
  path.join('billing', 'services', 'lemonsqueezy-webhook.service.ts'),
  path.join('billing', 'services', 'invoice.service.ts'),
  path.join('billing', 'services', 'invoice-sync.util.ts'),
  path.join('billing', 'services', 'subscription-sync.util.ts'),
  path.join('billing', 'services', 'payment-method.service.ts'),
  path.join('billing', 'services', 'customer.service.ts'),
  path.join('drizzle', 'seeds'),
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts'))
      out.push(full);
  }
  return out;
}

function isAllowed(file: string): boolean {
  return ALLOWED.some((a) => file.includes(a));
}

describe('provider isolation', () => {
  const files = walk(SRC).filter((f) => !isAllowed(f));

  it('finds source files to check (the walker is not silently empty)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('has no stripeService call outside the adapters', () => {
    const offenders = files.filter((f) =>
      /stripeService\./.test(fs.readFileSync(f, 'utf8')),
    );
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it('has no Lemon Squeezy API call outside the adapters', () => {
    const offenders = files.filter((f) =>
      /api\.lemonsqueezy\.com|LEMONSQUEEZY_API_KEY/.test(
        fs.readFileSync(f, 'utf8'),
      ),
    );
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and record what it catches**

Run: `npx jest src/billing/providers/provider-isolation.spec.ts`

Expected at this point: the `stripeService` test FAILS, listing the services that still call Stripe directly (`addon.service.ts`, `plan-change.service.ts`, `subscription.service.ts`, `billing.controller.ts`). That failure is the task list for Tasks 9–11. Do NOT widen `ALLOWED` to make it pass — the whole value is that it names the remaining work.

- [ ] **Step 3: Mark the test pending until Task 11 lands**

Change `it('has no stripeService call outside the adapters'` to `it.failing(...)` with this comment above it:

```ts
  // it.failing until Task 11 routes addon/plan-change/subscription through the
  // registry. Kept running (not skipped) so the day it starts passing is
  // visible, and so nobody widens ALLOWED instead of doing the work.
```

- [ ] **Step 4: Verify the suite is green with the pending marker**

Run: `npx jest src/billing/providers/provider-isolation.spec.ts`
Expected: PASS (3 tests, one reported as a passing `failing` test)

- [ ] **Step 5: Commit**

```bash
git add src/billing/providers/provider-isolation.spec.ts
git commit -m "test(billing): fail if a provider call escapes the adapters"
```

---

### Task 8: Lemon Squeezy HTTP client

Isolated so the adapter can be tested without network access.

**Files:**
- Create: `src/billing/providers/lemonsqueezy.client.ts`
- Test: `src/billing/providers/lemonsqueezy.client.spec.ts`

**Interfaces:**
- Produces: `LemonSqueezyClient` with
  `get<T>(path: string): Promise<T>`,
  `patch<T>(path: string, body: unknown): Promise<T>`,
  `post<T>(path: string, body: unknown): Promise<T>`,
  `delete<T>(path: string): Promise<T>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/billing/providers/lemonsqueezy.client.spec.ts
import { LemonSqueezyClient } from './lemonsqueezy.client';

describe('LemonSqueezyClient', () => {
  const OLD_KEY = process.env.LEMONSQUEEZY_API_KEY;

  beforeEach(() => {
    process.env.LEMONSQUEEZY_API_KEY = 'test-key';
  });
  afterEach(() => {
    process.env.LEMONSQUEEZY_API_KEY = OLD_KEY;
    jest.restoreAllMocks();
  });

  function mockFetch(status: number, body: unknown) {
    const fn = jest.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(JSON.stringify(body)),
    });
    (global as unknown as { fetch: unknown }).fetch = fn;
    return fn;
  }

  it('sends the JSON:API content type Lemon Squeezy requires', async () => {
    const fetchMock = mockFetch(200, { data: {} });
    await new LemonSqueezyClient().get('subscriptions/1');
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Accept']).toBe('application/vnd.api+json');
    expect(headers['Content-Type']).toBe('application/vnd.api+json');
  });

  it('sends the bearer token', async () => {
    const fetchMock = mockFetch(200, { data: {} });
    await new LemonSqueezyClient().get('subscriptions/1');
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-key');
  });

  // An expiring key is a silent, total outage — Lemon Squeezy keys expire one
  // year after creation — so the error must say what happened.
  it('reports an auth failure in terms of the key', async () => {
    mockFetch(401, { errors: [{ detail: 'Unauthenticated' }] });
    await expect(new LemonSqueezyClient().get('subscriptions/1')).rejects.toThrow(
      /LEMONSQUEEZY_API_KEY/,
    );
  });

  it('surfaces the provider error detail on other failures', async () => {
    mockFetch(422, { errors: [{ detail: 'Variant not found' }] });
    await expect(new LemonSqueezyClient().get('subscriptions/1')).rejects.toThrow(
      /Variant not found/,
    );
  });

  it('throws a clear error when the key is missing entirely', async () => {
    delete process.env.LEMONSQUEEZY_API_KEY;
    await expect(new LemonSqueezyClient().get('subscriptions/1')).rejects.toThrow(
      /LEMONSQUEEZY_API_KEY/,
    );
  });

  it('returns the parsed body on success', async () => {
    mockFetch(200, { data: { id: '2508067' } });
    await expect(new LemonSqueezyClient().get('subscriptions/1')).resolves.toEqual(
      { data: { id: '2508067' } },
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/billing/providers/lemonsqueezy.client.spec.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
// src/billing/providers/lemonsqueezy.client.ts
import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';

const BASE = 'https://api.lemonsqueezy.com/v1/';

/**
 * Thin HTTP client for the Lemon Squeezy API.
 *
 * Separate from the adapter so the adapter's fan-out logic can be tested
 * without network access, and so the JSON:API content types and auth header
 * are stated once.
 */
@Injectable()
export class LemonSqueezyClient {
  private readonly logger = new Logger(LemonSqueezyClient.name);

  private key(): string {
    const key = process.env.LEMONSQUEEZY_API_KEY;
    if (!key) {
      throw new InternalServerErrorException(
        'LEMONSQUEEZY_API_KEY is not set; billing cannot reach the provider.',
      );
    }
    return key;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
        Authorization: `Bearer ${this.key()}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    const parsed: unknown = text ? JSON.parse(text) : {};

    if (!res.ok) {
      const detail =
        (parsed as { errors?: { detail?: string }[] })?.errors?.[0]?.detail ??
        `HTTP ${res.status}`;

      // Keys expire ONE YEAR after creation and the failure is silent and
      // total, so 401 gets its own message naming the variable to check.
      if (res.status === 401) {
        throw new InternalServerErrorException(
          `Lemon Squeezy rejected the credentials (${detail}). ` +
            `LEMONSQUEEZY_API_KEY may have expired — keys last one year.`,
        );
      }

      throw new InternalServerErrorException(
        `Lemon Squeezy ${method} ${path} failed: ${detail}`,
      );
    }

    return parsed as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }
  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }
  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/billing/providers/lemonsqueezy.client.spec.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/billing/providers/lemonsqueezy.client.ts src/billing/providers/lemonsqueezy.client.spec.ts
git commit -m "feat(billing): a Lemon Squeezy HTTP client"
```

---

### Task 9: Lemon Squeezy adapter

The fan-out. This is the task with the real risk in it.

**Files:**
- Create: `src/billing/providers/lemonsqueezy.adapter.ts`
- Test: `src/billing/providers/lemonsqueezy.adapter.spec.ts`

**Interfaces:**
- Consumes: `LemonSqueezyClient`, `CatalogueService.resolveRef`, `PROVIDER_ITEM_ORDER`, `PurchaseResult`, `providerSubscriptions`.
- Produces: `LemonSqueezyAdapter implements PaymentProviderAdapter`.

- [ ] **Step 1: Write the failing test**

```ts
// src/billing/providers/lemonsqueezy.adapter.spec.ts
import { LemonSqueezyAdapter } from './lemonsqueezy.adapter';

type Row = {
  id: number;
  itemType: string;
  providerSubscriptionId: string;
  providerItemId: string;
};

function fiveRows(): Row[] {
  return [
    { id: 1, itemType: 'BASE_PLAN', providerSubscriptionId: '100', providerItemId: '900' },
    { id: 2, itemType: 'EXTRA_CHANNEL', providerSubscriptionId: '101', providerItemId: '901' },
    { id: 3, itemType: 'EXTRA_MEMBER', providerSubscriptionId: '102', providerItemId: '902' },
    { id: 4, itemType: 'EXTRA_WORKSPACE', providerSubscriptionId: '103', providerItemId: '903' },
    { id: 5, itemType: 'EXTRA_AI_TOKENS', providerSubscriptionId: '104', providerItemId: '904' },
  ];
}

function makeAdapter(rows: Row[], clientOverrides: Record<string, jest.Mock> = {}) {
  const updates: { id: number; set: Record<string, unknown> }[] = [];
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(rows),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockImplementation((set: Record<string, unknown>) => ({
        where: jest.fn().mockImplementation(() => {
          updates.push({ id: -1, set });
          return Promise.resolve(undefined);
        }),
      })),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
        onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
      }),
    }),
  };

  const client = {
    get: jest.fn().mockResolvedValue({ data: { attributes: {} } }),
    post: jest.fn().mockResolvedValue({
      data: { attributes: { url: 'https://ls.test/checkout/abc' } },
    }),
    patch: jest.fn().mockResolvedValue({ data: { attributes: {} } }),
    delete: jest.fn().mockResolvedValue({
      data: { attributes: { status: 'cancelled' } },
    }),
    ...clientOverrides,
  };

  const catalogue = { resolveRef: jest.fn().mockResolvedValue('2100632') };
  const adapter = new LemonSqueezyAdapter(
    db as never,
    client as never,
    catalogue as never,
  );
  return { adapter, client, catalogue, db, updates };
}

describe('LemonSqueezyAdapter.name', () => {
  it('identifies itself as lemonsqueezy', () => {
    const { adapter } = makeAdapter([]);
    expect(adapter.name).toBe('lemonsqueezy');
  });
});

describe('LemonSqueezyAdapter.purchaseAddon', () => {
  // No POST /v1/subscription-items exists, so a NEW add-on can only start at a
  // hosted checkout.
  it('returns a checkout url for an add-on the account does not have', async () => {
    const { adapter } = makeAdapter([
      { id: 1, itemType: 'BASE_PLAN', providerSubscriptionId: '100', providerItemId: '900' },
    ]);
    const result = await adapter.purchaseAddon(1, 'EXTRA_CHANNEL', 2);
    expect(result).toEqual({
      status: 'checkout_required',
      url: 'https://ls.test/checkout/abc',
    });
  });

  // Verified live 2026-09-07: PATCH with invoice_immediately charged PKR 400
  // at once and left renews_at untouched.
  it('updates quantity in place when the add-on already exists', async () => {
    const { adapter, client } = makeAdapter(fiveRows());
    const result = await adapter.purchaseAddon(1, 'EXTRA_CHANNEL', 5);
    expect(result).toEqual({ status: 'completed', quantity: 5 });
    expect(client.patch).toHaveBeenCalledWith(
      'subscription-items/901',
      expect.objectContaining({
        data: expect.objectContaining({
          attributes: expect.objectContaining({
            quantity: 5,
            invoice_immediately: true,
          }),
        }),
      }),
    );
  });
});

describe('LemonSqueezyAdapter.changeAddonQuantity', () => {
  it('invoices immediately so the charge is not deferred to renewal', async () => {
    const { adapter, client } = makeAdapter(fiveRows());
    await adapter.changeAddonQuantity(1, 'EXTRA_MEMBER', 4);
    expect(client.patch).toHaveBeenCalledWith(
      'subscription-items/902',
      expect.objectContaining({
        data: expect.objectContaining({
          attributes: expect.objectContaining({ invoice_immediately: true }),
        }),
      }),
    );
  });

  it('throws when the account has no such add-on', async () => {
    const { adapter } = makeAdapter([
      { id: 1, itemType: 'BASE_PLAN', providerSubscriptionId: '100', providerItemId: '900' },
    ]);
    await expect(
      adapter.changeAddonQuantity(1, 'EXTRA_CHANNEL', 2),
    ).rejects.toThrow(/EXTRA_CHANNEL/);
  });
});

describe('LemonSqueezyAdapter.removeAddon', () => {
  // An add-on IS a whole subscription here, so removing it means cancelling
  // that subscription, not deleting a line item.
  it('cancels the add-on’s own subscription', async () => {
    const { adapter, client } = makeAdapter(fiveRows());
    await adapter.removeAddon(1, 'EXTRA_CHANNEL');
    expect(client.delete).toHaveBeenCalledWith('subscriptions/101');
  });
});

describe('LemonSqueezyAdapter.cancel', () => {
  it('cancels every one of the five subscriptions', async () => {
    const { adapter, client } = makeAdapter(fiveRows());
    await adapter.cancel(1, true);
    expect(client.delete).toHaveBeenCalledTimes(5);
  });

  // Load-bearing. If the fan-out breaks midway the customer must still hold
  // the base plan; cancelling it first would end access while add-ons billed.
  it('cancels the base plan LAST', async () => {
    const { adapter, client } = makeAdapter(fiveRows());
    await adapter.cancel(1, true);
    const paths = client.delete.mock.calls.map((c: string[]) => c[0]);
    expect(paths[paths.length - 1]).toBe('subscriptions/100');
  });

  it('leaves the base plan alive when an add-on cancel fails midway', async () => {
    const failing = jest
      .fn()
      .mockResolvedValueOnce({ data: { attributes: { status: 'cancelled' } } })
      .mockRejectedValueOnce(new Error('provider 500'));
    const { adapter } = makeAdapter(fiveRows(), { delete: failing });

    await expect(adapter.cancel(1, true)).rejects.toThrow('provider 500');
    const paths = failing.mock.calls.map((c: string[]) => c[0]);
    expect(paths).not.toContain('subscriptions/100');
  });

  // A break midway must leave the database telling the truth about which rows
  // were actually cancelled, so reconciliation can repair it.
  it('records each cancellation as it happens, not after the whole fan-out', async () => {
    const failing = jest
      .fn()
      .mockResolvedValueOnce({ data: { attributes: { status: 'cancelled' } } })
      .mockRejectedValueOnce(new Error('provider 500'));
    const { adapter, db } = makeAdapter(fiveRows(), { delete: failing });

    await expect(adapter.cancel(1, true)).rejects.toThrow();
    expect(db.update).toHaveBeenCalledTimes(1);
  });
});

describe('LemonSqueezyAdapter.pause / resume', () => {
  // behavior 'void', not keep_as_draft: a returning customer must not be
  // handed a stack of back-invoices.
  it('pauses with mode void', async () => {
    const { adapter, client } = makeAdapter(fiveRows());
    await adapter.pause(1);
    expect(client.patch).toHaveBeenCalledWith(
      'subscriptions/100',
      expect.objectContaining({
        data: expect.objectContaining({
          attributes: expect.objectContaining({
            pause: { mode: 'void' },
          }),
        }),
      }),
    );
  });

  it('resumes by clearing the pause', async () => {
    const { adapter, client } = makeAdapter(fiveRows());
    await adapter.resume(1);
    expect(client.patch).toHaveBeenCalledWith(
      'subscriptions/100',
      expect.objectContaining({
        data: expect.objectContaining({
          attributes: expect.objectContaining({ pause: null }),
        }),
      }),
    );
  });

  it('pauses add-ons too, so nothing keeps billing while paused', async () => {
    const { adapter, client } = makeAdapter(fiveRows());
    await adapter.pause(1);
    expect(client.patch).toHaveBeenCalledTimes(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/billing/providers/lemonsqueezy.adapter.spec.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Write `src/billing/providers/lemonsqueezy.adapter.ts` implementing `PaymentProviderAdapter`, satisfying every test above. Required behaviours, all of which the tests pin:

- `name = 'lemonsqueezy'`.
- A private `rowsFor(subscriptionId)` reading `provider_subscriptions` filtered to `provider = 'lemonsqueezy'`.
- `purchaseAddon`: if a row for that `itemType` exists → `changeAddonQuantity` then return `{status:'completed', quantity}`; otherwise `POST /v1/checkouts` with `checkout_data.custom.user_id` and `variant_quantities`, returning `{status:'checkout_required', url}`.
- `changeAddonQuantity`: `PATCH subscription-items/{providerItemId}` with `{quantity, invoice_immediately: true}`. Throw a message naming the `itemType` if no row exists.
- `removeAddon`: `DELETE subscriptions/{providerSubscriptionId}` for that item type.
- `cancel`: iterate `PROVIDER_ITEM_ORDER`, skipping types the account lacks; `DELETE` each; **update that row in the database immediately after each success**; let an error propagate so the remaining items (including `BASE_PLAN`) are untouched.
- `pause` / `resume`: `PATCH subscriptions/{id}` with `pause: {mode:'void'}` / `pause: null`, across all rows.
- `changePlan`: `PATCH subscriptions/{basePlanId}` with the new `variant_id` from `catalogue.resolveRef` and `invoice_immediately: true`.
- `createCheckout`: `POST /v1/checkouts` with the store id from `LEMONSQUEEZY_STORE_ID`, the plan's variant from the catalogue, and `checkout_data.custom.user_id`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/billing/providers/lemonsqueezy.adapter.spec.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Mutation-test the cancel ordering**

Reverse `PROVIDER_ITEM_ORDER` in `payment-provider.interface.ts` and re-run this spec. Expected: the "cancels the base plan LAST" and "leaves the base plan alive" tests FAIL. Restore and re-run; expect PASS. This proves the ordering is genuinely enforced rather than incidental.

- [ ] **Step 6: Commit**

```bash
git add src/billing/providers/lemonsqueezy.adapter.ts src/billing/providers/lemonsqueezy.adapter.spec.ts
git commit -m "feat(billing): the Lemon Squeezy adapter, base plan cancelled last"
```

---

### Task 10: Stripe adapter

Wraps the existing `StripeService` behind the same interface, so callers stop naming Stripe.

**Files:**
- Create: `src/billing/providers/stripe.adapter.ts`
- Test: `src/billing/providers/stripe.adapter.spec.ts`

**Interfaces:**
- Consumes: `StripeService`, `CustomerService.getOrCreateStripeCustomer`, `CatalogueService.resolveRef`, `providerSubscriptions`.
- Produces: `StripeAdapter implements PaymentProviderAdapter`.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/billing/providers/stripe.adapter.spec.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Write `src/billing/providers/stripe.adapter.ts` implementing `PaymentProviderAdapter` over the existing `StripeService`, satisfying the tests above. It reads its `provider_subscriptions` rows the same way the Lemon Squeezy adapter does, so callers never pass a Stripe id. `getOrCreateStripeCustomer` is called **here** and nowhere else.

**Every method that acts on an existing subscription must call the Task 6
guard first**, passing the provider it read from the rows:

```ts
import { assertProviderIsStripe } from '../../stripe/stripe-guard.util';
import { pickDefaultProvider } from '../services/provider-subscription.util';

private async rowsFor(subscriptionId: number) {
  const rows = await this.db
    .select()
    .from(providerSubscriptions)
    .where(eq(providerSubscriptions.subscriptionId, subscriptionId));

  // Refuse before touching Stripe, not after. Without this the guard from
  // Task 6 is defined, tested, and never called — dead code protecting
  // nothing.
  assertProviderIsStripe(pickDefaultProvider(rows), subscriptionId);
  return rows;
}
```

`createCheckout` is the one exception: it runs before any provider row exists,
so there is nothing to check yet.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/billing/providers/stripe.adapter.spec.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/billing/providers/stripe.adapter.ts src/billing/providers/stripe.adapter.spec.ts
git commit -m "feat(billing): the Stripe adapter, owning its own customer creation"
```

---

### Task 11: Route the services through the registry

Makes the architecture test from Task 7 pass for real. This is the task that closes the line-62 hazard end to end.

**Files:**
- Modify: `src/billing/services/subscription.service.ts` (lines 62, 419, 618, 659, 717)
- Modify: `src/billing/services/addon.service.ts`
- Modify: `src/billing/services/plan-change.service.ts`
- Modify: `src/billing/billing.module.ts`
- Modify: `src/billing/providers/provider-isolation.spec.ts` (drop `it.failing`)

**Interfaces:**
- Consumes: `ProviderRegistryService`, `StripeAdapter`, `LemonSqueezyAdapter`, `PurchaseResult`.
- Produces: `ProviderRegistryService.adapterFor(userId: string): Promise<PaymentProviderAdapter>` and `adapterForSubscription(subscriptionId: number): Promise<PaymentProviderAdapter>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/billing/providers/provider-registry.adapter.spec.ts
import { ProviderRegistryService } from './provider-registry.service';

function makeRegistry(rows: Record<string, unknown>[]) {
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(rows),
        }),
        where: jest.fn().mockResolvedValue(rows),
      }),
    }),
  };
  const stripeAdapter = { name: 'stripe' };
  const lsAdapter = { name: 'lemonsqueezy' };
  const svc = new ProviderRegistryService(db as never);
  svc.register(stripeAdapter as never);
  svc.register(lsAdapter as never);
  return { svc, stripeAdapter, lsAdapter };
}

describe('ProviderRegistryService.adapterFor', () => {
  it('returns the adapter matching the account’s own provider', async () => {
    const { svc, lsAdapter } = makeRegistry([
      { provider: 'lemonsqueezy', isDefault: true },
    ]);
    await expect(svc.adapterFor('user-1')).resolves.toBe(lsAdapter);
  });

  it('returns the configured adapter for a brand-new account', async () => {
    process.env.BILLING_PROVIDER = 'lemonsqueezy';
    const { svc, lsAdapter } = makeRegistry([]);
    await expect(svc.adapterFor('user-new')).resolves.toBe(lsAdapter);
  });

  it('throws if no adapter is registered for the resolved provider', async () => {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([
              { provider: 'stripe', isDefault: true },
            ]),
          }),
        }),
      }),
    };
    const svc = new ProviderRegistryService(db as never);
    await expect(svc.adapterFor('user-1')).rejects.toThrow(/stripe/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/billing/providers/provider-registry.adapter.spec.ts`
Expected: FAIL — `svc.register is not a function`

- [ ] **Step 3: Add adapter resolution to the registry**

Add to `ProviderRegistryService`:

```ts
  private readonly adapters = new Map<PaymentProvider, PaymentProviderAdapter>();

  register(adapter: PaymentProviderAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  private adapterOf(provider: PaymentProvider): PaymentProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new InternalServerErrorException(
        `No adapter is registered for provider "${provider}".`,
      );
    }
    return adapter;
  }

  async adapterFor(userId: string): Promise<PaymentProviderAdapter> {
    return this.adapterOf(await this.providerForUser(userId));
  }

  async adapterForSubscription(
    subscriptionId: number,
  ): Promise<PaymentProviderAdapter> {
    const provider =
      (await this.defaultProviderFor(subscriptionId)) ??
      this.configuredProvider();
    return this.adapterOf(provider);
  }
```

Register both adapters in `BillingModule` with a factory provider that calls `register()` on each.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/billing/providers/provider-registry.adapter.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Replace the Stripe call sites**

In `subscription.service.ts`, `addon.service.ts` and `plan-change.service.ts`, replace each direct `this.stripeService.*` billing call with the corresponding adapter method obtained from the registry. In particular:

- `subscription.service.ts:62` — delete the unconditional `getOrCreateStripeCustomer`; the adapter now does it.
- `subscription.service.ts:419` — same, and call `adapter.createCheckout(...)`.
- `subscription.service.ts:618/659/717` — `adapter.pause/resume/cancel`.
- `addon.service.ts` — `adapter.purchaseAddon` / `changeAddonQuantity` / `removeAddon`; handle the `checkout_required` branch by returning the url to the controller.
- `plan-change.service.ts` — `adapter.changePlan`.

- [ ] **Step 6: Un-pend the architecture test**

Remove `it.failing` from `provider-isolation.spec.ts` (restore plain `it`), and remove any service from `ALLOWED` that no longer needs to be there.

- [ ] **Step 7: Verify everything**

```bash
npx jest src/billing/ src/stripe/
npx tsc --noEmit 2>&1 | grep -c "error TS"     # expect 21
npx nest build
npx ts-node -r tsconfig-paths/register --transpile-only boot-check.ts   # expect BOOT_OK
npx jest 2>&1 | grep -E "Tests:"               # expect only the known 4 failures
```

- [ ] **Step 8: Commit**

```bash
git add -A src/billing src/stripe
git commit -m "feat(billing): route every billing operation through its provider"
```

---

### Task 12: Lemon Squeezy webhooks

**Files:**
- Create: `src/billing/services/lemonsqueezy-webhook.service.ts`
- Create: `src/billing/services/lemonsqueezy-webhook.service.spec.ts`
- Modify: `src/billing/billing.controller.ts` (add `POST /billing/webhooks/lemonsqueezy`)
- Modify: `src/billing/billing.module.ts`

**Interfaces:**
- Consumes: `mapLemonSqueezyStatus`, `providerSubscriptions`, `subscriptions`.
- Produces: `LemonSqueezyWebhookService.verifySignature(raw: Buffer, signature: string): boolean` and `handleEvent(eventName: string, payload: unknown): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/billing/services/lemonsqueezy-webhook.service.spec.ts
import * as crypto from 'crypto';
import { LemonSqueezyWebhookService } from './lemonsqueezy-webhook.service';

function sign(raw: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(raw).digest('hex');
}

describe('LemonSqueezyWebhookService.verifySignature', () => {
  const OLD = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  beforeEach(() => {
    process.env.LEMONSQUEEZY_WEBHOOK_SECRET = 'shhh';
  });
  afterEach(() => {
    process.env.LEMONSQUEEZY_WEBHOOK_SECRET = OLD;
  });

  function make() {
    return new LemonSqueezyWebhookService({} as never);
  }

  it('accepts a correctly signed body', () => {
    const raw = '{"meta":{"event_name":"subscription_created"}}';
    expect(make().verifySignature(Buffer.from(raw), sign(raw, 'shhh'))).toBe(
      true,
    );
  });

  it('rejects a body signed with the wrong secret', () => {
    const raw = '{"meta":{}}';
    expect(
      make().verifySignature(Buffer.from(raw), sign(raw, 'wrong')),
    ).toBe(false);
  });

  it('rejects a tampered body', () => {
    const raw = '{"meta":{}}';
    const sig = sign(raw, 'shhh');
    expect(make().verifySignature(Buffer.from('{"meta":{"x":1}}'), sig)).toBe(
      false,
    );
  });

  it('rejects a malformed signature without throwing', () => {
    expect(make().verifySignature(Buffer.from('{}'), 'not-hex')).toBe(false);
  });

  it('rejects when no secret is configured, rather than accepting everything', () => {
    delete process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
    const raw = '{}';
    expect(make().verifySignature(Buffer.from(raw), sign(raw, 'shhh'))).toBe(
      false,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/billing/services/lemonsqueezy-webhook.service.spec.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Implement `verifySignature` with `crypto.createHmac('sha256', secret)` over the **raw** body, compared using `crypto.timingSafeEqual` inside a try/catch (differing buffer lengths throw). Return `false` when the secret is unset — never `true`.

Implement `handleEvent(eventName, payload)`:

- Find the `provider_subscriptions` row by `provider_subscription_id`.
- **Read `item_type` from that row.** Never infer it from the variant id.
- Update the row's `provider_status`, `provider_quantity`, `renews_at`, `ends_at`.
- If `item_type === 'BASE_PLAN'`, map the status with `mapLemonSqueezyStatus` and update `subscriptions.status` / `cancelAtPeriodEnd`.
- On `subscription_created` from a checkout, insert the row (reading `user_id` from `checkout_data.custom`) and set `is_default = true` when the account has no other default.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/billing/services/lemonsqueezy-webhook.service.spec.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Add the controller route**

Add `POST billing/webhooks/lemonsqueezy` mirroring the existing Stripe webhook route's raw-body handling, reading the `x-signature` header, returning 400 on a failed verification.

- [ ] **Step 6: Verify boot and full suite**

```bash
npx nest build
npx ts-node -r tsconfig-paths/register --transpile-only boot-check.ts   # BOOT_OK
npx jest 2>&1 | grep -E "Tests:"
```

- [ ] **Step 7: Commit**

```bash
git add src/billing/services/lemonsqueezy-webhook.service.ts src/billing/services/lemonsqueezy-webhook.service.spec.ts src/billing/billing.controller.ts src/billing/billing.module.ts
git commit -m "feat(billing): handle Lemon Squeezy webhooks"
```

---

### Task 13: Seed provider prices and verify live

Populates `provider_prices` and confirms the whole path works against the real API.

**Files:**
- Create: `src/drizzle/seeds/provider-prices.seed.ts`

**Interfaces:**
- Consumes: `providerPrices`, the `LEMONSQUEEZY_VARIANT_*` env vars.

- [ ] **Step 1: Write the seed**

An idempotent upsert (on the `(provider, plan_code, item_type)` unique constraint) inserting, for `lemonsqueezy`:

- `('lemonsqueezy', 'BASIC', 'BASE_PLAN', LEMONSQUEEZY_VARIANT_BASIC)`
- `('lemonsqueezy', 'PRO', 'BASE_PLAN', LEMONSQUEEZY_VARIANT_PRO)`
- `('lemonsqueezy', 'MAX', 'BASE_PLAN', LEMONSQUEEZY_VARIANT_MAX)`
- `('lemonsqueezy', 'PRO', 'EXTRA_CHANNEL', LEMONSQUEEZY_VARIANT_EXTRA_CHANNEL)`

Skip any whose env var is unset, and log which were skipped rather than inserting an empty ref.

- [ ] **Step 2: Note the outstanding catalogue gap**

Only `EXTRA_CHANNEL` has a Lemon Squeezy variant so far. `EXTRA_MEMBER`, `EXTRA_WORKSPACE` and `EXTRA_AI_TOKENS` need products created in the Lemon Squeezy dashboard before their adapter paths can be exercised live. Record this in the ledger; `CatalogueService` already throws a message naming the missing row, so the failure is clear rather than mysterious.

- [ ] **Step 3: Apply migrations to the local database**

Migrations 0032 and 0033 must be applied by hand (never `npm run db:migrate`).

- [ ] **Step 4: Live verification in Lemon Squeezy test mode**

With test mode on:

1. Create a checkout via the adapter; complete it with card `4242 4242 4242 4242`.
2. Confirm a `provider_subscriptions` row exists with `is_default = true`, the right `item_type`, and a `provider_item_id`.
3. Change the add-on quantity; confirm an invoice appears **immediately** and `renews_at` does **not** move.
4. Cancel; confirm status becomes `cancelled` with `ends_at` in the future, and that our `subscriptions.status` stays `active` with `cancelAtPeriodEnd = true` — **not** `canceled`.
5. Delete the test subscription afterwards.

- [ ] **Step 5: Commit**

```bash
git add src/drizzle/seeds/provider-prices.seed.ts
git commit -m "feat(billing): seed Lemon Squeezy variant ids"
```

---

## Deferred, deliberately

- **PayPal branch.** Lemon Squeezy subscriptions paid via PayPal cannot be updated through the API at all — the endpoint silently no-ops — and must redirect to `urls.customer_portal_update_subscription`. Needs handling at every update site. No PayPal customer can exist before we are live.
- **Reconciliation cron.** Nightly diff of `provider_subscriptions` against the provider, logging drift without auto-correcting. Its own effort; the schema already supports it via `providerQuantity` vs `subscription_items.quantity`.
- **`GET /billing/portal`.** The Lemon Squeezy hosted-portal endpoint replacing the six payment-method endpoints for LS customers. Frontend work pairs with it.
- **Frontend.** Untouched throughout; it still assumes per-workspace billing and has no surface for pause/resume, channel locking, pooled counts, or a checkout redirect on add-on purchase.
