# Payment provider abstraction — design

**Date:** 2026-09-08
**Branch:** `feat/billing-account-scope`
**Depends on:** `399dc08` (the `provider_subscriptions` table), migration 0032

## Why

Lemon Squeezy goes live first — it is a Merchant of Record, so it is the legal
seller, handles tax itself, and pays out to Pakistan. Stripe returns once the
LLC and a live Stripe account exist. **Both then stay**: accounts move over one
at a time at their own renewal dates, so for a whole billing cycle new signups
are on Stripe while existing customers finish their Lemon Squeezy period. There
is no moment when only one provider is in use.

Today there is **not a single provider branch anywhere in the billing code**.
All 39 Stripe call sites across 8 files run unconditionally. That is the real
problem this design solves — not "how do we call two APIs", but "how do we make
it impossible for a Lemon Squeezy customer to silently take a Stripe code
path".

### The concrete hazard

`subscription.service.ts:62`:

```ts
async createSubscription(dto) {
  const { stripeCustomerId } =
    await this.customerService.getOrCreateStripeCustomer(dto.userId);  // ← line 62
  ...
  const plan = await db.select()...                                    // plan read AFTER
```

A Lemon Squeezy signup would create a Stripe customer, call the Stripe API, and
write `stripe_customer_id` to our database. Silently. No error. The same shape
exists at `subscription.service.ts:419` (`createCheckoutSession`).

Abstracting only `purchaseAddon`/`changePlan` would leave both of these intact.

## Scope

**In scope** — the billing operations that actually differ between providers:
`createCheckout`, `changePlan`, `purchaseAddon`, `changeAddonQuantity`,
`removeAddon`, `pause`, `resume`, `cancel`.

**Out of scope** — payment methods, invoices, and customers stay as they are.
A Merchant of Record genuinely *is* different: Lemon Squeezy owns the card
relationship and exposes only a hosted portal URL. Inventing a card-list
abstraction over something that does not exist is how a provider abstraction
becomes, in the words of the research, "a lowest-common-denominator lie plus a
jsonb where the real behavior hides."

## Verified provider facts

Established against the live Lemon Squeezy API in test mode (2026-09-07), not
from documentation, which contradicted itself on the third point:

| Fact | Evidence |
|---|---|
| No `POST /v1/subscription-items` | API reference lists only GET/PATCH/list |
| One subscription holds ONE variant | Object exposes `first_subscription_item` |
| `invoice_immediately` **works** on quantity change | qty 1→3 produced `PKR 400`, status `paid`, `billing_reason: updated` |
| Renewal date does **not** move on quantity change | `renews_at` stayed `2026-10-07` |
| `cancelled` does **not** revoke access | DELETE returned `status: cancelled` with `ends_at` a month out |
| Checkout accepts `custom` metadata | Used to carry our `user_id` |
| PayPal subscriptions cannot be updated by API | Documented; update endpoint silently no-ops |

The third row matters most. The API reference said `invoice_immediately`
existed; the usage-based-billing guide said proration goes on the next invoice.
The guide was wrong. This is why **changing** an existing add-on is a one-click
in-app operation on both providers, while **buying a new** add-on needs a
checkout redirect on Lemon Squeezy only.

## Architecture

### 1. The interface — modelled on intent

```ts
interface PaymentProviderAdapter {
  readonly name: PaymentProvider;

  createCheckout(userId: string, planCode: string): Promise<{ url: string }>;
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

**No method takes or returns a provider id.** They take our `subscriptionId`
and an `itemType`; the adapter looks up its own `provider_subscriptions` rows.
If a `subscriptionItemId` leaked into a signature, the Lemon Squeezy adapter
could not be written at all — it has no single item to name.

`purchaseAddon` returns a discriminated result, because the two providers
genuinely differ here and pretending otherwise would hide it:

```ts
type PurchaseResult =
  | { status: 'completed'; quantity: number }
  | { status: 'checkout_required'; url: string };
```

Stripe returns `completed` (item added, invoiced now). Lemon Squeezy returns
`checkout_required` for a NEW add-on, because no API can create a subscription
there. Callers must handle both, so the compiler forces the redirect case to be
dealt with rather than forgotten.

### What each adapter does differently

| Operation | Stripe | Lemon Squeezy |
|---|---|---|
| `purchaseAddon` (new) | Add item + invoice now → `completed` | Create checkout → `checkout_required` |
| `changeAddonQuantity` | Update item quantity | `PATCH` item, `invoice_immediately: true` |
| `removeAddon` | Delete the item | **Cancel that whole subscription** |
| `cancel` | One call | **Fan out across N subscriptions** |
| `pause` | `pause_collection: {behavior:'void'}` | `pause: {mode:'void'}` |
| `changePlan` | Update item price | `PATCH variant_id` + `invoice_immediately` |

### 2. Provider selection — one door

`ProviderRegistry.resolveFor(userId)`:

1. Look for the account's `provider_subscriptions` row with `is_default = true`
   → that provider.
2. No rows (a new customer) → the `BILLING_PROVIDER` env var, currently
   `lemonsqueezy`.

An existing customer therefore **never** changes provider implicitly — their
own row decides. New customers switch with one env flip when Stripe goes live;
no code change.

`getOrCreateStripeCustomer` moves out of `subscription.service` and **into the
Stripe adapter**, so it can only run when the Stripe adapter was selected. This
is what closes the line-62 hazard.

### 3. Leak prevention — three layers

Layer 1 and 2 exist because the failure mode is *silence*. A Stripe call on a
Lemon Squeezy customer does not throw today; it succeeds, charges the wrong
place or writes the wrong id, and is discovered weeks later.

**Layer 1 — runtime assertion.** Each billing method on `StripeService` begins
with a check that Stripe is this subscription's default provider, and throws
otherwise. Converts a silent months-later discovery into a loud immediate 500,
usually during testing.

**Layer 2 — architecture test.** A test scans `src/` and fails if any
`stripeService.` or Lemon Squeezy call appears outside the adapter directory.
This is the layer that protects future work, including my own.

**Layer 3 — separate webhook routes.** `/webhooks/stripe` already exists;
`/webhooks/lemonsqueezy` is new, with its own signature verification. Neither
route can reach the other provider's subscriptions.

**Payment-method endpoints** (6 of them) return a clear error for a Lemon
Squeezy customer rather than an empty list — an empty list reads as "no cards
saved", which is a lie. `GET /billing/portal` replaces them, returning Lemon
Squeezy's hosted portal URL. That URL is signed and expires in 24 hours, so it
is fetched fresh every time and never cached.

### 4. Webhooks

Lemon Squeezy signs with HMAC-SHA256 over the **raw body**, in the
`X-Signature` header, compared with `timingSafeEqual`. The route needs raw-body
access, exactly like the Stripe route.

Routing: look up the row by `provider_subscription_id`, then **read its
`item_type` column** to know whether the event concerns the base plan or an
add-on. Never infer this from a variant id — that breaks silently the first
time the catalogue changes.

Events: `subscription_created`, `subscription_updated` (a catch-all that fires
after most others), `subscription_cancelled`, `subscription_resumed`,
`subscription_expired`, `subscription_paused`, `subscription_unpaused`,
`subscription_payment_success`, `subscription_payment_failed`,
`subscription_payment_recovered`, `subscription_payment_refunded`.

Lifecycle events carry a Subscription; payment events carry a Subscription
**invoice** — a different payload shape on the same route.

#### Status mapping

| Lemon Squeezy | Ours | Access |
|---|---|---|
| `on_trial` | `trialing` | yes |
| `active` | `active` | yes |
| `paused` | `paused` | yes, at FREE limits |
| `past_due` | `past_due` | yes — dunning is still retrying |
| `unpaid` | `past_due` | yes |
| **`cancelled`** | **`active`** with `cancelAtPeriodEnd = true` | **yes, until `ends_at`** |
| `expired` | `canceled` | no |

The `cancelled` row is the trap. Lemon Squeezy's docs are explicit that
customers keep access in every status except `expired`. Mapping `cancelled`
onto our `canceled` would cut off a paying customer the moment they schedule a
cancellation. Already encoded and mutation-tested in
`provider-subscription.util.ts:isLive()`.

`unpaid` has no equivalent in our enum and can persist indefinitely if store
dunning is disabled, so it folds into `past_due`.

### 5. Fan-out failure

`cancel` and `removeAddon` make N calls on Lemon Squeezy. Two rules govern
partial failure:

**Add-ons first, base plan last.** If the sequence breaks midway the customer
still has their base plan, so the service keeps working. The reverse order
would cancel the base plan and leave add-ons billing — access gone, charges
continuing. That is the worst reachable state.

**Write to the database after each call, not after the whole fan-out.** One
call succeeds, that row updates immediately. A break midway leaves the database
telling the truth: three cancelled, two not. Reconciliation can then repair it.
Deferring the writes would leave every row wrong.

### 6. Reconciliation

A nightly cron diffs `provider_subscriptions` against what each provider
actually holds. Stripe's own engineering blog states that the first
reconciliation run on a six-month-old codebase always finds drift — and that is
about Stripe's own webhooks. Causes include expired retry windows, portal
changes made while a handler errored, and the fact that **event ordering is not
guaranteed**, so a later event can arrive before an earlier one.

Discrepancies are **logged, not auto-corrected**. Auto-correction touches
money; a human decides.

This is only possible because `providerQuantity` (billing) is stored separately
from `subscription_items.quantity` (entitlement) — the difference between them
*is* the drift signal.

## Testing

- **Adapter unit tests** with the provider API stubbed: the five-row Lemon
  Squeezy fan-out, a mid-fan-out failure, cancel ordering.
- **Architecture test**: no provider call outside the adapter directory.
- **Guard test**: a Stripe call against a Lemon Squeezy subscription throws.
- **Status mapping**: the whole table, `cancelled` especially.
- **Live test** in Lemon Squeezy test mode, as done on 2026-09-07 for the
  proration question.

## Explicitly not doing

- **Payment-method abstraction** — see Scope.
- **Auto-correcting reconciliation drift** — logged only.
- **Migrating existing Stripe customers** — there are none in live mode;
  migration 0030 truncates the two test-mode rows.
- **The PayPal branch** — Lemon Squeezy subscriptions paid by PayPal cannot be
  updated through the API at all (the endpoint silently no-ops), and must
  instead redirect to `urls.customer_portal_update_subscription`. Real, and
  deferred: it needs its own handling everywhere an update happens, and no
  PayPal customer can exist until we are live. Tracked here so it is not
  forgotten.

## Decisions that could have gone either way

**The portal URL gets its own endpoint** (`GET /billing/portal`) rather than
riding along on the subscription-details response. Returning it inline would
mean fetching a signed, 24-hour URL from Lemon Squeezy on every subscription
read — and the dashboard reads subscription details constantly while almost
never needing the portal. One extra call, only when the user opens billing
settings.

**A missing `is_default` row falls back to the env var, not to Stripe.**
Hardcoding Stripe as the fallback would reintroduce exactly the silent-Stripe
problem this design exists to prevent: any account whose provider row failed to
write would quietly bill through Stripe. The env var means such an account
follows whatever we are currently signing people up with.

**The guard throws rather than logging a warning.** A warning would be ignored
in a log nobody reads until a customer complains. Since no Stripe call should
ever reach a Lemon Squeezy subscription, any that does is a bug worth failing
the request over.
