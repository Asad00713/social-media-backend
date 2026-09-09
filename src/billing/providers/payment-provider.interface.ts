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
