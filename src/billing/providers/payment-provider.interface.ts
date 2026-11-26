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

/**
 * Which way a plan change moves, which decides whether the remaining part of
 * the period is billed now (`up`) or not at all (`down`).
 *
 * Named by DIRECTION rather than by proration mode, because each provider
 * spells the mechanism differently — Paddle has `proration_billing_mode`,
 * Lemon Squeezy has `invoice_immediately`, Stripe has proration behaviours —
 * and the interface is meant to carry intent, not one provider's vocabulary.
 */
export type PlanChangeDirection = 'up' | 'down';

/**
 * What the hosted billing portal should open on. `update_payment_method` goes
 * straight to the card form where the provider supports it; `portal` is the
 * provider's general customer page.
 */
export type PortalIntent = 'portal' | 'update_payment_method';

/**
 * One invoice, in our vocabulary rather than the provider's. `void` is part of
 * the union on purpose: both providers can void an invoice and the settings
 * screen shows it distinctly from a failed one.
 */
export interface ProviderInvoice {
  id: string;
  /** ISO 8601. */
  date: string;
  description: string;
  amountCents: number;
  currency: string;
  status: 'paid' | 'pending' | 'failed' | 'refunded' | 'void';
  downloadUrl: string | null;
}

/**
 * The card and billing contact on file. `billingDetails` is null where the
 * provider does not hand them over (Stripe: we mirror cards, not customers).
 */
export interface BillingProfile {
  card: { brand: string | null; last4: string | null } | null;
  billingDetails: {
    name: string | null;
    email: string | null;
    country: string | null;
  } | null;
}

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

  /**
   * Move the account to another paid plan.
   *
   * `direction` exists because the money moves differently each way and only
   * the caller knows which way it is going:
   *
   * - `up`: the part of the period still to run is charged NOW, so an upgrade
   *   on the 15th of a monthly cycle collects about half the difference. This
   *   is the industry norm and what the plan UI promises.
   * - `down`: nothing is billed now. The current period was already invoiced
   *   at the OLD price, and `plan-change.service.ts` keeps the customer on
   *   that plan until `currentPeriodEnd` — so charging or crediting here would
   *   refund half a month the customer then goes on using.
   *
   * It is a required argument rather than something each adapter infers:
   * inferring it means reading the old and new prices and comparing them,
   * which is a second source of truth about which direction a change is, next
   * to the `PLAN_HIERARCHY` the service already decided it with.
   */
  changePlan(
    subscriptionId: number,
    newPlanCode: string,
    direction: PlanChangeDirection,
  ): Promise<void>;

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

  /**
   * A signed link into the provider's hosted billing portal. `workspaceId` is
   * the workspace the caller is acting in: where the portal sends the person
   * back to. A provider with no such notion ignores it.
   */
  createPortalLink(
    subscriptionId: number,
    intent: PortalIntent,
    opts?: { workspaceId?: string },
  ): Promise<{ url: string }>;

  /** Newest first, at most `limit`. */
  listInvoices(
    subscriptionId: number,
    limit: number,
  ): Promise<ProviderInvoice[]>;

  getBillingProfile(subscriptionId: number): Promise<BillingProfile>;
}
