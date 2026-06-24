# Stripe Checkout Subscribe Flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Backend (Tasks 1–4) ships before frontend (Tasks 5–6).

**Goal:** A FREE-plan user can only move to a paid plan by going through Stripe Checkout (hosted) — which collects a card, handles SCA, creates the subscription, and charges the first invoice — and the local subscription is synced from the `checkout.session.completed` webhook. Direct paid-creation without a card is blocked.

**Architecture:** New `POST /billing/workspaces/:workspaceId/checkout-session` returns a Stripe Checkout `subscription`-mode session URL using the provisioned `stripePriceId`. Frontend redirects to it. On completion, a webhook persists the local subscription via a shared idempotent `persistStripeSubscription` helper (upserts the workspace `subscriptions` row, `BASE_PLAN` item, and `workspace_usage` limits). Defense-in-depth guards stop the legacy direct paths from creating incomplete subscriptions.

**Tech Stack:** NestJS, Drizzle (node-postgres), Stripe Node SDK, Jest (backend); React 19 + TanStack Query + react-router + shadcn (frontend).

**Reference spec:** `docs/superpowers/specs/2026-06-24-stripe-checkout-subscribe-design.md`.

**Repos:**
- Backend: `d:\My Documents\MyProjects\FullStackProjects\socialmedia-workspace` (branch `feat/railway-migration-stripe-billing`)
- Frontend: `d:\My Documents\MyProjects\FullStackProjects\socialmedia-frontend` (branch `ui-improvements`)

**Known facts (from code):**
- `subscription.service.ts` imports `subscriptions, subscriptionItems, workspaceUsage, plans, workspace, NewSubscription, NewSubscriptionItem, NewWorkspaceUsage` and injects `StripeService` + `CustomerService`. `getOrCreateStripeCustomer(userId)` → `{ stripeCustomerId }`.
- `subscriptions` is `UNIQUE(workspace_id)`; a FREE workspace already has a row (from `createFreeSubscription`), so FREE→paid must **update** it.
- `subscription_items` is `UNIQUE(subscription_id, item_type)`; `workspace_usage` is `UNIQUE(workspace_id)`.
- `webhook.service.ts` routes `customer.subscription.*` + invoice events; `handleSubscriptionCreated` is a no-op. Controller already imports `RawBodyRequest` (raw body for Stripe signatures exists).
- Stripe SDK apiVersion in `stripe.service.ts` is `'2025-12-15.clover'`.
- `process.env.FRONTEND_URL` is available (used in `main.ts`).

---

## Task 1: Checkout-session endpoint (backend)

**Files:**
- Modify: `src/stripe/stripe.service.ts` (add `createCheckoutSession`)
- Modify: `src/billing/services/subscription.service.ts` (add `createCheckoutSession` orchestration)
- Modify: `src/billing/billing.controller.ts` (add endpoint)

- [ ] **Step 1: Confirm the frontend Plans route prefix**

In the FRONTEND repo, read `src/router.tsx` and confirm the full authenticated path to the Plans page. The nested route is `settings/plans`; find its parent prefix (expected `/dashboard/:workspaceId`). Use the confirmed prefix when building URLs below. If it differs from `/dashboard/${workspaceId}/settings/plans`, use the real one.

- [ ] **Step 2: Add the low-level Stripe call** to `src/stripe/stripe.service.ts` (place it near `createSubscription`):

```ts
async createCheckoutSession(params: {
  customerId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
}): Promise<Stripe.Checkout.Session> {
  return await this.stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: params.customerId,
    line_items: [{ price: params.priceId, quantity: 1 }],
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    metadata: params.metadata,
    subscription_data: { metadata: params.metadata },
    allow_promotion_codes: false,
  });
}
```

- [ ] **Step 3: Add orchestration** to `src/billing/services/subscription.service.ts`:

```ts
async createCheckoutSession(dto: {
  workspaceId: string;
  userId: string;
  planCode: string;
}): Promise<{ url: string }> {
  // 1. Validate workspace exists and user is owner (mirror createSubscription).
  const ws = await db
    .select()
    .from(workspace)
    .where(
      and(
        eq(workspace.id, dto.workspaceId),
        eq(workspace.ownerId, dto.userId),
      ),
    )
    .limit(1);
  if (ws.length === 0) {
    throw new NotFoundException(
      'Workspace not found or you are not the owner',
    );
  }

  // 2. Resolve the plan and ensure it is paid + provisioned.
  const planRows = await db
    .select()
    .from(plans)
    .where(eq(plans.code, dto.planCode))
    .limit(1);
  const plan = planRows[0];
  if (!plan) throw new NotFoundException('Plan not found');
  if (plan.basePriceCents <= 0) {
    throw new BadRequestException('FREE plan does not require checkout');
  }
  if (!plan.stripePriceId) {
    throw new BadRequestException(
      `Plan "${plan.code}" is not provisioned in Stripe — run the pricing provision script`,
    );
  }

  // 3. Stripe customer + redirect URLs.
  const { stripeCustomerId } =
    await this.customerService.getOrCreateStripeCustomer(dto.userId);
  const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3001';
  const base = `${frontendUrl}/dashboard/${dto.workspaceId}/settings/plans`;

  const session = await this.stripeService.createCheckoutSession({
    customerId: stripeCustomerId,
    priceId: plan.stripePriceId,
    successUrl: `${base}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${base}?checkout=cancelled`,
    metadata: {
      workspaceId: dto.workspaceId,
      userId: dto.userId,
      planCode: dto.planCode,
    },
  });

  if (!session.url) {
    throw new BadRequestException('Failed to create checkout session');
  }
  return { url: session.url };
}
```

> Use the route prefix confirmed in Step 1 when writing `base`. `{CHECKOUT_SESSION_ID}` is Stripe's literal token — leave it verbatim.

- [ ] **Step 4: Add the controller endpoint** to `src/billing/billing.controller.ts` (after `createSubscription`):

```ts
@Post('workspaces/:workspaceId/checkout-session')
@UseGuards(JwtAuthGuard)
@HttpCode(HttpStatus.OK)
async createCheckoutSession(
  @Param('workspaceId') workspaceId: string,
  @CurrentUser() user: { userId: string },
  @Body() body: { planCode: string },
) {
  return await this.subscriptionService.createCheckoutSession({
    workspaceId,
    userId: user.userId,
    planCode: body.planCode,
  });
}
```

- [ ] **Step 5: Build**

Run: `npm run build` → expected: succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/stripe/stripe.service.ts src/billing/services/subscription.service.ts src/billing/billing.controller.ts
git commit -m "feat(billing): checkout-session endpoint (subscription mode, provisioned price)"
```

---

## Task 2: `persistStripeSubscription` shared helper + tests (backend)

**Files:**
- Create: `src/billing/services/subscription-sync.util.ts` (pure value builder)
- Create: `src/billing/services/subscription-sync.util.spec.ts`
- Modify: `src/billing/services/subscription.service.ts` (add `persistStripeSubscription` using the builder + upserts)

The pure builder is unit-tested (no DB). The orchestration does idempotent upserts (verified by build + smoke).

- [ ] **Step 1: Write the failing test** — `src/billing/services/subscription-sync.util.spec.ts`:

```ts
import { buildSubscriptionSync } from './subscription-sync.util';

const PLAN = {
  code: 'PRO',
  basePriceCents: 1000,
  channelsPerWorkspace: 8,
  membersPerWorkspace: 5,
  aiTokensPerMonth: 2000,
} as any;

function makeStripeSub(overrides: any = {}) {
  return {
    id: 'sub_123',
    status: 'active',
    customer: 'cus_123',
    current_period_start: 1_700_000_000,
    current_period_end: 1_702_000_000,
    items: { data: [{ id: 'si_123', price: { id: 'price_123' } }] },
    ...overrides,
  } as any;
}

describe('buildSubscriptionSync', () => {
  it('maps stripe subscription + plan into row values', () => {
    const out = buildSubscriptionSync({
      workspaceId: 'ws-1',
      planCode: 'PRO',
      plan: PLAN,
      stripeCustomerId: 'cus_123',
      stripeSubscription: makeStripeSub(),
    });

    expect(out.subscriptionRow).toMatchObject({
      workspaceId: 'ws-1',
      stripeCustomerId: 'cus_123',
      stripeSubscriptionId: 'sub_123',
      planCode: 'PRO',
      status: 'active',
    });
    expect(out.subscriptionRow.currentPeriodStart).toEqual(
      new Date(1_700_000_000 * 1000),
    );
    expect(out.subscriptionRow.currentPeriodEnd).toEqual(
      new Date(1_702_000_000 * 1000),
    );
    // trialEnd omitted when no trial
    expect('trialEnd' in out.subscriptionRow).toBe(false);

    expect(out.baseItem).toMatchObject({
      stripeSubscriptionItemId: 'si_123',
      itemType: 'BASE_PLAN',
      stripePriceId: 'price_123',
      quantity: 1,
      unitPriceCents: 1000,
    });

    expect(out.usageRow).toMatchObject({
      workspaceId: 'ws-1',
      channelsLimit: 8,
      membersLimit: 5,
      aiTokensLimit: 2000,
    });
  });

  it('includes trialEnd when the subscription is trialing', () => {
    const out = buildSubscriptionSync({
      workspaceId: 'ws-1',
      planCode: 'PRO',
      plan: PLAN,
      stripeCustomerId: 'cus_123',
      stripeSubscription: makeStripeSub({
        status: 'trialing',
        trial_end: 1_701_000_000,
      }),
    });
    expect(out.subscriptionRow.trialEnd).toEqual(
      new Date(1_701_000_000 * 1000),
    );
    expect(out.subscriptionRow.status).toBe('trialing');
  });
});
```

- [ ] **Step 2: Run → fail**

Run: `npx jest src/billing/services/subscription-sync.util.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure builder** — `src/billing/services/subscription-sync.util.ts`:

```ts
import type Stripe from 'stripe';

export interface SubscriptionSyncInput {
  workspaceId: string;
  planCode: string;
  plan: {
    basePriceCents: number;
    channelsPerWorkspace: number;
    membersPerWorkspace: number;
    aiTokensPerMonth: number;
  };
  stripeCustomerId: string;
  stripeSubscription: Stripe.Subscription;
}

export interface SubscriptionSyncValues {
  subscriptionRow: Record<string, unknown>;
  baseItem: Record<string, unknown>;
  usageRow: Record<string, unknown>;
}

/**
 * Pure mapping from a Stripe subscription + our plan into the DB row values
 * used to upsert `subscriptions`, the BASE_PLAN `subscription_items` row, and
 * `workspace_usage`. No DB access — unit-testable. Null timestamps are omitted
 * (Drizzle rejects explicit null for timestamp columns).
 */
export function buildSubscriptionSync(
  input: SubscriptionSyncInput,
): SubscriptionSyncValues {
  const sub = input.stripeSubscription as any;
  const baseStripeItem = sub.items?.data?.[0];

  const subscriptionRow: Record<string, unknown> = {
    workspaceId: input.workspaceId,
    stripeCustomerId: input.stripeCustomerId,
    stripeSubscriptionId: sub.id,
    planCode: input.planCode,
    status: sub.status,
    currentPeriodStart: sub.current_period_start
      ? new Date(sub.current_period_start * 1000)
      : new Date(),
    currentPeriodEnd: sub.current_period_end
      ? new Date(sub.current_period_end * 1000)
      : null,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
  };
  if (sub.trial_end) {
    subscriptionRow.trialEnd = new Date(sub.trial_end * 1000);
  }

  const baseItem: Record<string, unknown> = {
    stripeSubscriptionItemId: baseStripeItem?.id ?? null,
    itemType: 'BASE_PLAN',
    stripePriceId: baseStripeItem?.price?.id ?? '',
    quantity: 1,
    unitPriceCents: input.plan.basePriceCents,
  };

  const usageRow: Record<string, unknown> = {
    workspaceId: input.workspaceId,
    channelsLimit: input.plan.channelsPerWorkspace,
    membersLimit: input.plan.membersPerWorkspace,
    aiTokensLimit: input.plan.aiTokensPerMonth,
  };

  return { subscriptionRow, baseItem, usageRow };
}
```

- [ ] **Step 4: Run → pass**

Run: `npx jest src/billing/services/subscription-sync.util.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the orchestration method** to `src/billing/services/subscription.service.ts`. Import the builder and the `sql` helper:

At the top, add to existing imports:
```ts
import { eq, and, sql } from 'drizzle-orm';
import { buildSubscriptionSync } from './subscription-sync.util';
```

Add the method (public — the webhook calls it):

```ts
/**
 * Idempotently persist a Stripe subscription into our DB (subscriptions +
 * BASE_PLAN item + workspace_usage). Used by the checkout webhook and any
 * direct path. Upserts on the workspace's existing row (FREE→paid updates the
 * pre-existing FREE row rather than inserting a duplicate).
 */
async persistStripeSubscription(input: {
  workspaceId: string;
  planCode: string;
  stripeCustomerId: string;
  stripeSubscription: Stripe.Subscription;
}): Promise<void> {
  const planRows = await db
    .select()
    .from(plans)
    .where(eq(plans.code, input.planCode))
    .limit(1);
  const plan = planRows[0];
  if (!plan) {
    throw new NotFoundException(`Plan "${input.planCode}" not found`);
  }

  const { subscriptionRow, baseItem, usageRow } = buildSubscriptionSync({
    workspaceId: input.workspaceId,
    planCode: input.planCode,
    plan,
    stripeCustomerId: input.stripeCustomerId,
    stripeSubscription: input.stripeSubscription,
  });

  // 1. Upsert the subscriptions row (UNIQUE workspace_id → updates FREE row).
  const subSet: Record<string, unknown> = {
    stripeCustomerId: sql`excluded.stripe_customer_id`,
    stripeSubscriptionId: sql`excluded.stripe_subscription_id`,
    planCode: sql`excluded.plan_code`,
    status: sql`excluded.status`,
    currentPeriodStart: sql`excluded.current_period_start`,
    currentPeriodEnd: sql`excluded.current_period_end`,
    cancelAtPeriodEnd: sql`excluded.cancel_at_period_end`,
    updatedAt: new Date(),
  };
  if ('trialEnd' in subscriptionRow) {
    subSet.trialEnd = sql`excluded.trial_end`;
  }
  await db
    .insert(subscriptions)
    .values(subscriptionRow as NewSubscription)
    .onConflictDoUpdate({ target: subscriptions.workspaceId, set: subSet });

  // 2. Get the subscription id for the item upsert.
  const savedRows = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(eq(subscriptions.workspaceId, input.workspaceId))
    .limit(1);
  const subscriptionId = savedRows[0].id;

  // 3. Upsert the BASE_PLAN item (UNIQUE subscription_id + item_type).
  await db
    .insert(subscriptionItems)
    .values({ ...baseItem, subscriptionId } as NewSubscriptionItem)
    .onConflictDoUpdate({
      target: [subscriptionItems.subscriptionId, subscriptionItems.itemType],
      set: {
        stripeSubscriptionItemId: sql`excluded.stripe_subscription_item_id`,
        stripePriceId: sql`excluded.stripe_price_id`,
        quantity: sql`excluded.quantity`,
        unitPriceCents: sql`excluded.unit_price_cents`,
        updatedAt: new Date(),
      },
    });

  // 4. Upsert workspace_usage limits (UNIQUE workspace_id).
  await db
    .insert(workspaceUsage)
    .values(usageRow as NewWorkspaceUsage)
    .onConflictDoUpdate({
      target: workspaceUsage.workspaceId,
      set: {
        channelsLimit: sql`excluded.channels_limit`,
        membersLimit: sql`excluded.members_limit`,
        aiTokensLimit: sql`excluded.ai_tokens_limit`,
        updatedAt: new Date(),
      },
    });
}
```

> **Implementer:** verify the exact column names referenced in `excluded.*` against `src/drizzle/schema/billing.schema.ts` (e.g. `stripe_subscription_item_id`, `ai_tokens_limit`). Verify `workspaceUsage` and `subscriptionItems` have an `updatedAt` column before setting it; if a table has no `updatedAt`, drop that line for that table. If `NewWorkspaceUsage` requires non-null fields not present in `usageRow` (e.g. counts), add them with their existing defaults (`channelsCount: 0`, `membersCount: 0`) — mirror `createFreeSubscription`.

- [ ] **Step 6: Build + test**

Run: `npm run build` → succeeds.
Run: `npx jest src/billing/services/subscription-sync.util.spec.ts` → 2 pass.

- [ ] **Step 7: Commit**

```bash
git add src/billing/services/subscription-sync.util.ts src/billing/services/subscription-sync.util.spec.ts src/billing/services/subscription.service.ts
git commit -m "feat(billing): idempotent persistStripeSubscription + pure sync builder"
```

---

## Task 3: `checkout.session.completed` webhook handler (backend)

**Files:**
- Modify: `src/billing/services/webhook.service.ts`

- [ ] **Step 1: Inspect** `src/billing/services/webhook.service.ts` — read the constructor (injected deps), the `switch` in `handleWebhook` (~L52), and confirm whether `SubscriptionService` and `StripeService` are already injected. Note the import block.

- [ ] **Step 2: Inject services** (if not already present). Add to the constructor:
```ts
private subscriptionService: SubscriptionService,
private stripeService: StripeService,
```
and import them:
```ts
import { SubscriptionService } from './subscription.service';
import { StripeService } from '../../stripe/stripe.service';
```
> `SubscriptionService` and `StripeService` are both provided by `BillingModule` (the controller already uses them), so DI resolves. If a circular-import warning appears, use `forwardRef` — but `subscription.service` does not import `webhook.service`, so a direct injection should be fine.

- [ ] **Step 3: Add the switch case** in `handleWebhook` (alongside the other `case` labels):
```ts
case 'checkout.session.completed':
  await this.handleCheckoutSessionCompleted(
    event.data.object as Stripe.Checkout.Session,
  );
  break;
```

- [ ] **Step 4: Add the handler method**:
```ts
private async handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  this.logger.log(`Checkout session completed: ${session.id}`);

  if (session.mode !== 'subscription' || !session.subscription) {
    return; // not a subscription checkout — ignore
  }

  const subscriptionId =
    typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription.id;

  // Retrieve the full subscription to read items, period, and metadata.
  const stripeSubscription =
    await this.stripeService.getSubscription(subscriptionId);

  const meta = (stripeSubscription.metadata ??
    session.metadata ??
    {}) as Record<string, string>;
  const workspaceId = meta.workspaceId;
  const planCode = meta.planCode;

  if (!workspaceId || !planCode) {
    this.logger.error(
      `checkout.session.completed ${session.id} missing workspaceId/planCode metadata`,
    );
    return;
  }

  const stripeCustomerId =
    typeof stripeSubscription.customer === 'string'
      ? stripeSubscription.customer
      : stripeSubscription.customer.id;

  await this.subscriptionService.persistStripeSubscription({
    workspaceId,
    planCode,
    stripeCustomerId,
    stripeSubscription,
  });

  this.logger.log(
    `Synced subscription ${subscriptionId} for workspace ${workspaceId} (${planCode})`,
  );
}
```

> **Implementer:** confirm `StripeService` exposes a `getSubscription(id)` (it had `getCustomer`; check for an equivalent subscription retrieve — the existing `handleSubscriptionUpdated` receives the subscription from the event, so a retrieve helper may not exist yet). If there is no `getSubscription`, add a thin one to `stripe.service.ts`:
> ```ts
> async getSubscription(id: string): Promise<Stripe.Subscription> {
>   return await this.stripe.subscriptions.retrieve(id);
> }
> ```
> The default retrieve includes `items` and period fields; no `expand` needed for our mapping.

- [ ] **Step 5: Build**

Run: `npm run build` → succeeds. (Idempotency is provided by Task 2's upserts + the existing `billing_events` dedupe in `handleWebhook`.)

- [ ] **Step 6: Commit**

```bash
git add src/billing/services/webhook.service.ts src/stripe/stripe.service.ts
git commit -m "feat(billing): sync local subscription on checkout.session.completed"
```

---

## Task 4: Defense-in-depth guards (backend)

**Files:**
- Modify: `src/billing/services/subscription.service.ts`
- Modify: `src/billing/services/plan-change.service.ts`

Stop the legacy direct paths from creating a paid subscription with no card.

- [ ] **Step 1: Add a payment-method check helper** to `src/stripe/stripe.service.ts`:
```ts
async customerHasPaymentMethod(customerId: string): Promise<boolean> {
  const methods = await this.stripe.paymentMethods.list({
    customer: customerId,
    type: 'card',
    limit: 1,
  });
  return methods.data.length > 0;
}
```

- [ ] **Step 2: Guard `subscription.service.createSubscription`** — in the paid path, BEFORE creating the Stripe subscription (right after the FREE short-circuit / payment-method attach block, where `stripePriceId` is resolved), add:
```ts
// Guard: a paid subscription must have a card. FREE→paid goes through
// Checkout; this direct path must never create an incomplete subscription.
if (!dto.paymentMethodId) {
  const hasCard =
    await this.stripeService.customerHasPaymentMethod(stripeCustomerId);
  if (!hasCard) {
    throw new BadRequestException(
      'A payment method is required for a paid plan — subscribe via Checkout',
    );
  }
}
```
> Place this so it only runs for the paid path (after `if (dto.planCode === 'FREE') return ...`). `BadRequestException` is already imported.

- [ ] **Step 3: Guard `plan-change.service.ts` FREE→paid branch** — find the branch that creates a Stripe subscription for an upgrade from FREE (around the `else if (!sub.stripeSubscriptionId && targetPriceId && target.basePriceCents > 0)` block). BEFORE calling `this.stripeService.createSubscription(...)`, add:
```ts
const hasCard = await this.stripeService.customerHasPaymentMethod(
  sub.stripeCustomerId,
);
if (!hasCard) {
  throw new BadRequestException(
    'A payment method is required to upgrade to a paid plan — subscribe via Checkout',
  );
}
```
> Confirm `BadRequestException` is imported in `plan-change.service.ts`; add it to the `@nestjs/common` import if missing. Confirm `this.stripeService` is the injected `StripeService` (it is used elsewhere in the file).

- [ ] **Step 4: Build + lint**

Run: `npm run build` → succeeds.
Run: `npm run lint` → no NEW errors.

- [ ] **Step 5: Commit**

```bash
git add src/stripe/stripe.service.ts src/billing/services/subscription.service.ts src/billing/services/plan-change.service.ts
git commit -m "feat(billing): require a payment method for direct paid subscription paths"
```

---

## Task 5: Frontend — checkout API, hook, redirect on subscribe

**Repo:** `socialmedia-frontend`. **Files:**
- Modify: `src/features/billing/api/billing.api.ts`
- Create: `src/features/billing/hooks/use-create-checkout-session.ts`
- Modify: `src/features/billing/components/plans/plan-card.tsx`

- [ ] **Step 1: Read the conventions** — read `src/features/billing/api/billing.api.ts` (how `apiClient.post` is used and whether it returns the body or an axios response) and `src/features/billing/hooks/use-change-plan.ts` (mutation + toast pattern). Mirror these exactly in the steps below.

- [ ] **Step 2: Add the API function** in `billing.api.ts` (match the existing return style — if other functions return `apiClient.post<T>(...)` directly, do the same):
```ts
createCheckoutSession: (workspaceId: string, body: { planCode: string }) =>
  apiClient.post<{ url: string }>(
    `/billing/workspaces/${workspaceId}/checkout-session`,
    body,
  ),
```

- [ ] **Step 3: Create the hook** — `src/features/billing/hooks/use-create-checkout-session.ts`. Mirror `use-change-plan.ts`'s structure (query client, toast on error). On success, redirect:
```ts
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { billingApi } from '../api/billing.api'

/**
 * Starts a Stripe Checkout session for a FREE→paid upgrade and redirects the
 * browser to Stripe's hosted page. Card + SCA + first charge happen there;
 * the local subscription is synced by the checkout webhook on return.
 */
export function useCreateCheckoutSession(workspaceId: string) {
  return useMutation({
    mutationFn: async (planCode: string) => {
      const res = await billingApi.createCheckoutSession(workspaceId, {
        planCode,
      })
      // Match billing.api's return shape — if it returns the body directly,
      // use `res.url`; if it returns an axios response, use `res.data.url`.
      return res
    },
    onSuccess: (res) => {
      const url = (res as { url?: string }).url ?? (res as any)?.data?.url
      if (url) window.location.assign(url)
      else toast.error('Could not start checkout. Please try again.')
    },
    onError: (err) => {
      toast.error(
        err instanceof Error ? err.message : 'Could not start checkout.',
      )
    },
  })
}
```
> **Implementer:** resolve the `res` shape concretely from Step 1 and remove the dual-shape fallback — use the one true shape (`res.url` or `res.data.url`). Confirm the toast import path matches the project (`sonner` vs a shadcn `useToast`); use whatever `use-change-plan.ts` uses.

- [ ] **Step 4: Wire the subscribe button** in `src/features/billing/components/plans/plan-card.tsx`. Read the file first. Determine the current plan code for the workspace (read how `PlansShell` / `use-workspace-plans` exposes the active plan; the comparison/confirm flow already knows it). Then:
  - If the **current plan is FREE** (i.e. no active paid Stripe subscription) → clicking "Subscribe to X" calls `useCreateCheckoutSession(workspaceId).mutate(plan.code)` (shows a button spinner while `isPending`), instead of opening `PlanChangeConfirmDialog`.
  - If the current plan is a **paid** plan (paid→paid change) → keep the existing `PlanChangeConfirmDialog` path unchanged.
  - Pass `workspaceId` / `currentPlanCode` into `PlanCard` from `PlansShell` if not already available (PlansShell has `useWorkspaceId()` and the plans query).

> Keep the button's loading/disabled states (shadcn `Button` + `Loader2`) consistent with the rest of the page. Do not introduce non-shadcn UI.

- [ ] **Step 5: Verify**

Run (frontend repo): `npm run build` → tsc + vite succeed.
Run: `npx eslint src/features/billing/api/billing.api.ts src/features/billing/hooks/use-create-checkout-session.ts src/features/billing/components/plans/plan-card.tsx` → clean.

- [ ] **Step 6: Commit** (SURGICAL — never `git add .`; never stage `.env`):

```bash
git add src/features/billing/api/billing.api.ts src/features/billing/hooks/use-create-checkout-session.ts src/features/billing/components/plans/plan-card.tsx
git commit -m "feat(billing): redirect FREE->paid subscribe to Stripe Checkout"
```

---

## Task 6: Frontend — checkout return handling on the Plans page

**Repo:** `socialmedia-frontend`. **Files:**
- Modify: `src/features/billing/components/plans-shell.tsx`

- [ ] **Step 1: Read** `plans-shell.tsx` (already uses `useSearchParams`) and `src/features/billing/hooks/use-workspace-plans.ts` to find the query key(s) to invalidate/refetch for the active subscription + plans.

- [ ] **Step 2: Handle the return params** in `PlansShell`. Add an effect that reads `?checkout`:
  - `success` → show a success toast ("Subscription active — finalizing…"), then refetch the workspace subscription/plans query a few times with a short delay (the webhook may lag by a second or two) until the active plan flips away from FREE; once updated (or after ~5 attempts), clear the `checkout` + `session_id` params from the URL (use `setSearchParams` to remove them, replace history).
  - `cancelled` → show a neutral toast/inline note ("Checkout cancelled — no changes made") and clear the param.

```ts
// inside PlansShell, after existing hooks
const [params, setParams] = useSearchParams()
const checkoutState = params.get('checkout')
const queryClient = useQueryClient()

useEffect(() => {
  if (!checkoutState) return

  if (checkoutState === 'cancelled') {
    toast.info('Checkout cancelled — no changes made.')
  } else if (checkoutState === 'success') {
    toast.success('Payment received — activating your plan…')
    // Refetch a few times to absorb webhook lag.
    let attempts = 0
    const tick = () => {
      attempts += 1
      void queryClient.invalidateQueries({
        queryKey: /* the workspace plans/subscription key from Step 1 */,
      })
      if (attempts < 5) window.setTimeout(tick, 1500)
    }
    tick()
  }

  // Clean the URL so a refresh doesn't re-trigger.
  const next = new URLSearchParams(params)
  next.delete('checkout')
  next.delete('session_id')
  setParams(next, { replace: true })
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [checkoutState])
```
> **Implementer:** replace the `queryKey` placeholder with the real key from Step 1 (e.g. the key used by `useWorkspacePlans`). Use the project's toast (`sonner` or shadcn). Ensure `useEffect`, `useQueryClient`, `toast` are imported. Keep the existing `useSearchParams` usage (don't duplicate the hook call — reuse/rename the existing `params`).

- [ ] **Step 3: Verify**

Run: `npm run build` → succeeds.
Run: `npx eslint src/features/billing/components/plans-shell.tsx` → clean.

- [ ] **Step 4: Commit**

```bash
git add src/features/billing/components/plans-shell.tsx
git commit -m "feat(billing): handle Stripe Checkout success/cancel return on Plans page"
```

---

## Out of scope (YAGNI)

- paid→paid change flow (unchanged — card already on file).
- Apple/Google Pay, promo codes, tax, annual prices.
- A success-route session-retrieve fallback if the webhook never lands (optional follow-up; the retry-refetch covers normal lag).

## Risks / notes

- **Webhook secret:** local testing needs a real `STRIPE_WEBHOOK_SECRET` via `stripe listen` (currently a placeholder). Without it the sync never fires. This is an ops step, not code.
- **Column-name accuracy:** the `excluded.*` upserts in Task 2 must match `billing.schema.ts` exactly — the implementer verifies before committing.
- **Route prefix:** Task 1 Step 1 confirms the real Plans route so success/cancel URLs are correct.
- **`getSubscription` helper:** Task 3 adds it to `stripe.service.ts` only if absent.
