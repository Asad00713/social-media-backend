# Stripe Checkout Subscribe Flow — Design

**Date:** 2026-06-24
**Status:** Approved in principle (Checkout chosen over Elements; full SCA-compliant)
**Repos:** `socialmedia-workspace` (backend, primary) + `socialmedia-frontend` (redirect + return UI)

## Problem

A user on the **FREE** plan can switch to a **paid** plan **without entering any card**. The frontend subscribe/upgrade dialog never collects a card and never checks for one; the backend creates the Stripe subscription with `payment_behavior: 'default_incomplete'` and **no payment method**, so the subscription lands in `incomplete` status (no money taken, broken state) while the UI shows "Upgraded!".

## Decision (locked with user)

- **FREE → paid (new subscription): use Stripe Checkout (hosted, `mode: 'subscription'`).** Stripe collects the card, handles SCA/3DS, creates the subscription, and charges the first invoice. We pass the **provisioned** `stripePriceId` (from the lookup_key billing work).
- **paid → paid (plan change): unchanged.** A card is already on file; the existing in-app proration + `subscription.update` flow stays.
- **Full SCA-compliant:** delegated to Checkout (subscription mode performs SCA at purchase). No hand-rolled PaymentIntent confirmation needed.

## Why Checkout (not Elements)

Checkout natively does card collection + SCA + subscription creation + first charge in one redirect, with Stripe-maintained PCI/SCA. Elements would require hand-rolling the SCA dance (SetupIntent → attach → `default_incomplete` sub → confirm PaymentIntent → handle 3DS), which is the most error-prone part of a money flow. Given "full SCA-compliant," Checkout removes that risk. Trade-off accepted: one redirect out-and-back + reliance on a webhook to sync state.

---

## Architecture

### New happy path (FREE → paid)

1. Frontend: user clicks **Subscribe to <PAID>** → calls `POST /billing/workspaces/:workspaceId/checkout-session` with `{ planCode }`.
2. Backend: validate the plan is paid (`basePriceCents > 0`) and **provisioned** (`stripePriceId` present); get-or-create the Stripe customer; create a Checkout Session and return `{ url }`.
3. Frontend: `window.location.assign(url)` → Stripe hosted page.
4. User pays (card + SCA). Stripe creates the subscription (`active`/`trialing`) and charges invoice #1.
5. Stripe fires **`checkout.session.completed`** → backend **persists the local subscription** (idempotent; upserts the workspace's `subscriptions` row, inserts the `BASE_PLAN` subscription item, updates `workspace_usage` limits).
6. Stripe redirects to `success_url` → frontend refetches the workspace subscription (with a short retry, since the webhook may lag) and shows success.
7. Cancel → `cancel_url` returns to the Plans page with a dismissable "checkout cancelled" note.

### Checkout Session params (backend)

```
mode: 'subscription'
line_items: [{ price: plan.stripePriceId, quantity: 1 }]
customer: <stripeCustomerId>
success_url: `${FRONTEND_URL}/dashboard/${workspaceId}/settings/plans?checkout=success&session_id={CHECKOUT_SESSION_ID}`
cancel_url:  `${FRONTEND_URL}/dashboard/${workspaceId}/settings/plans?checkout=cancelled`
subscription_data: { metadata: { workspaceId, userId, planCode } }
metadata: { workspaceId, userId, planCode }
allow_promotion_codes: false
```

`{CHECKOUT_SESSION_ID}` is Stripe's literal placeholder — Stripe substitutes the real id. `subscription_data.metadata` is what lets the webhook map the Stripe subscription back to our workspace.

### Webhook sync (the core backend work)

`webhook.service.ts` already routes `customer.subscription.created/updated/deleted` + invoice events, but `handleSubscriptionCreated` is a **no-op** ("already created by createSubscription"). That assumption breaks under Checkout — Stripe creates the subscription, our app did not. So:

- **Add a `checkout.session.completed` handler.** It retrieves the subscription (`session.subscription`, expanded), reads `metadata.{workspaceId,userId,planCode}`, and **persists the local subscription** via a shared helper.
- **Extract a shared `persistStripeSubscription(...)` helper** (in `subscription.service.ts` or a small new service) that both the legacy direct path and the webhook use, so DB-write logic isn't duplicated. It must:
  - **Upsert on `workspace_id`** (the `subscriptions` table is `UNIQUE(workspace_id)`): a FREE workspace already has a `subscriptions` row from `createFreeSubscription`, so FREE→paid must **UPDATE** that row (planCode, stripeSubscriptionId, status, period start/end, trialEnd) — not insert (would violate the unique constraint).
  - Upsert the `BASE_PLAN` row in `subscription_items` (unique `(subscription_id, item_type)`).
  - Update `workspace_usage` limits (channelsLimit, membersLimit, aiTokensLimit) to the new plan.
  - Be **idempotent**: Stripe retries webhooks; re-processing the same `checkout.session.completed` must not double-insert or error. (The existing `billing_events` table already dedupes by `stripe_event_id` at the dispatcher; the persist helper must also be safe on its own.)

### Backend guard (defense-in-depth)

Even though FREE→paid now goes through Checkout, the **direct** paid-creation paths must not be able to create an incomplete subscription:

- `subscription.service.createSubscription`: for a **paid** plan with **no** `paymentMethodId` and **no** default payment method on the customer → throw `BadRequestException('A payment method is required — subscribe via Checkout')`. (FREE is already short-circuited and stays free.)
- `plan-change.service` FREE→paid branch (creates a Stripe sub at ~L361–389): same guard — if the customer has no default payment method, throw and direct to Checkout. (paid→paid already has a card, unaffected.)

This makes the bug unreproducible even via direct API calls.

---

## Frontend changes (`socialmedia-frontend`)

- **API:** add `createCheckoutSession(workspaceId, { planCode })` in `billing.api.ts` → returns `{ url }`. New hook `use-create-checkout-session.ts`.
- **Subscribe action:** in `plan-card.tsx` / the confirm flow, FREE→paid (i.e. current plan is FREE) clicks → call the hook → `window.location.assign(url)`. (paid→paid keeps the existing `PlanChangeConfirmDialog` + proration path.)
- **Return handling:** on the Plans page, read `?checkout=success|cancelled`:
  - `success` → toast + **refetch** the workspace subscription with a few short retries (webhook lag), show a brief "Finalizing your subscription…" state until the plan flips; then clean the query param.
  - `cancelled` → dismissable info ("Checkout cancelled — no changes made"); clean the query param.
- No new card UI in-app for this path (Checkout owns it). The existing payment-methods management (Elements add-card) is untouched.

---

## Ops / environment

- **`STRIPE_WEBHOOK_SECRET` is currently a placeholder** (`whsec_temp_development_only`). For local testing, run `stripe listen --forward-to localhost:3000/billing/webhook` (or the real webhook path) to get a real `whsec_...` and set it in backend `.env`. Without a valid secret, `constructEvent` signature verification fails and the local subscription never syncs. Production needs the dashboard webhook endpoint's signing secret.
- Confirm the actual webhook route path in `billing.controller.ts` and the raw-body handling needed for Stripe signature verification (Stripe requires the raw request body).
- `FRONTEND_URL` must be set (already used for CORS) so success/cancel URLs resolve.

## Out of scope (YAGNI)

- Replacing the paid→paid plan-change flow (it already collects nothing because a card exists; proration via `subscription.update` stays).
- Apple/Google Pay, promo codes, tax, annual prices (Checkout supports them later via config; not now).
- In-app Elements subscribe (explicitly rejected in favour of Checkout).
- Migrating any existing `incomplete` subscriptions (fresh DB; none exist).

## Risks

- **Webhook is now load-bearing.** If `checkout.session.completed` isn't received/verified, the user paid but the local plan doesn't flip. Mitigations: success-page retry/refetch; the webhook secret must be real; idempotent persist; log + alert on persist failure. Consider a fallback that retrieves the session on the success route and syncs if the webhook hasn't landed (optional follow-up).
- **FREE row upsert:** must UPDATE the existing FREE `subscriptions` row, not INSERT (unique `workspace_id`). Handled in the persist helper.
- **Raw body for signature:** Stripe webhook signature verification needs the raw body; ensure the route isn't pre-parsed by a JSON body parser.

## Decomposition (for the plan)

1. **Backend:** `createCheckoutSession` (stripe.service) + endpoint + DTO.
2. **Backend:** `persistStripeSubscription` shared helper (upsert workspace sub + item + usage), unit-tested.
3. **Backend:** `checkout.session.completed` webhook handler wired to the persist helper (idempotent).
4. **Backend:** defense-in-depth guards in `subscription.service` + `plan-change.service`.
5. **Frontend:** API + hook + redirect on subscribe (FREE→paid).
6. **Frontend:** success/cancel return handling on the Plans page.

## Testing / verification

Backend: `npm run build` + `npm run lint`; Jest unit tests for `persistStripeSubscription` (FREE-row update path, fresh-insert path, idempotent re-run) and for the checkout-session params builder. Frontend: `npm run build` (tsc) + scoped eslint; manual smoke with `stripe listen` + a Checkout test card (incl. a 3DS test card `4000 0027 6000 3184` to confirm SCA).
