import {
  PaymentProvider,
  ProviderItemType,
  ProviderSubscription,
} from '../../drizzle/schema';

/**
 * Reading a set of provider records for one account.
 *
 * An account holds one `subscriptions` row (our model) and N
 * `provider_subscriptions` rows (what the providers hold). On Stripe N is 1;
 * on Lemon Squeezy N is up to 5, because a Lemon Squeezy subscription carries
 * exactly one variant and every add-on is therefore its own subscription.
 *
 * During the Lemon Squeezy -> Stripe migration both providers appear at once:
 * each account moves at its own renewal date, so for a whole billing cycle
 * some accounts hold a lapsing Lemon Squeezy record and a fresh Stripe one.
 * Every function here is written for that overlap rather than against it.
 */

/** The provider currently billing this account. */
export function pickDefaultProvider(
  rows: ProviderSubscription[],
): PaymentProvider | null {
  const row = rows.find((r) => r.isDefault);
  return row ? (row.provider as PaymentProvider) : null;
}

/**
 * The rows belonging to one provider, for when a caller must act through a
 * specific one (cancelling the old provider during migration, say).
 */
export function rowsForProvider(
  rows: ProviderSubscription[],
  provider: PaymentProvider,
): ProviderSubscription[] {
  return rows.filter((r) => r.provider === provider);
}

/**
 * The single record covering one part of the subscription at the DEFAULT
 * provider — the base plan, or one add-on type.
 *
 * Scoped to the default deliberately: during migration an account can hold
 * both a Lemon Squeezy and a Stripe BASE_PLAN, and a lookup that ignored the
 * flag would return whichever row happened to come back first.
 */
export function findItem(
  rows: ProviderSubscription[],
  itemType: ProviderItemType,
): ProviderSubscription | null {
  const provider = pickDefaultProvider(rows);
  if (!provider) return null;
  return (
    rows.find((r) => r.provider === provider && r.itemType === itemType) ?? null
  );
}

/** The pre-abstraction facts about an account, for the legacy fallback below. */
export interface LegacyStripeFacts {
  /** `subscriptions.stripe_subscription_id`. */
  stripeSubscriptionId: string | null;
}

/**
 * The sentinel `createFreeSubscription` writes into `stripe_subscription_id`.
 * It is not a Stripe id and nothing is being billed for it.
 */
function isRealStripeSubscriptionId(id: string | null): boolean {
  return Boolean(id) && !id!.startsWith('free-plan');
}

/**
 * Does this account have a live BASE_PLAN at its current provider — i.e. is
 * anything actually being billed right now?
 *
 * The provider-neutral replacement for `if (sub.stripeSubscriptionId)`, which
 * was the discriminator every paid/unpaid branch used to key on. That column is
 * NULL for every Lemon Squeezy account (nothing writes it outside the Stripe
 * path), so those branches read "this customer pays nothing" for customers who
 * were very much being charged — stripping them to FREE locally while the
 * provider billed on.
 *
 * Reads `provider_subscriptions`, which every provider writes, and honours
 * `isLive` so a Lemon Squeezy `cancelled` row that has not reached `ends_at`
 * still counts as billing.
 *
 * THE LEGACY FALLBACK
 *
 * `legacy` is not belt-and-braces; without it this function was WRONG for the
 * entire paying population. `provider_subscriptions` was created by 0032 and
 * read by six files, and nothing ever wrote a BASE_PLAN row into it — so every
 * pre-existing Stripe subscriber had `stripe_subscription_id` set and zero
 * provider rows, and this returned false for all of them: `downgradeToFree`
 * stripped them to FREE without cancelling (Stripe billed on forever) and
 * `changePlan` created a second live subscription (double-billing).
 *
 * Migration 0034 backfills those rows and `writeStripeBasePlanRow` writes them
 * from now on, so the fallback should be dead weight in a healthy database.
 * It stays because "the row is missing" and "the account is not being billed"
 * are different facts, and only one of them is safe to guess wrong. A missing
 * row must never be read as "cancel nothing, charge on".
 *
 * It fires ONLY when there is no Stripe row at all. Once a Stripe row exists
 * it is authoritative — including when it says `expired`, which is exactly
 * what `clearStaleStripeSubscription` writes to route a dead id to Checkout.
 * Reading the stale column instead would resurrect the 500 that recovery
 * exists to prevent.
 */
export function hasLiveBasePlan(
  rows: ProviderSubscription[],
  legacy?: LegacyStripeFacts,
): boolean {
  const base = findItem(rows, 'BASE_PLAN');
  if (base) return isLive(base);

  if (!legacy) return false;

  // A Stripe row of ANY item type means this account has been through the
  // provider table, so its silence about the base plan is information rather
  // than an absence of it.
  const hasAnyStripeRow = rows.some((r) => r.provider === 'stripe');
  if (hasAnyStripeRow) return false;

  return isRealStripeSubscriptionId(legacy.stripeSubscriptionId);
}

/**
 * Does this account still have anything live at a non-default provider?
 *
 * True during the migration window: the customer has moved to Stripe but their
 * Lemon Squeezy subscription runs to the end of the period they already paid
 * for. Both must keep working until it lapses.
 */
export function hasLegacyProvider(rows: ProviderSubscription[]): boolean {
  const current = pickDefaultProvider(rows);
  if (!current) return false;
  return rows.some((r) => r.provider !== current && isLive(r));
}

/**
 * Is this provider record still entitling the customer to something?
 *
 * The Lemon Squeezy trap lives here. Its `cancelled` does NOT mean access has
 * ended — the subscription runs to `ends_at` and only then becomes `expired`.
 * Their docs are explicit that customers keep access in every status except
 * `expired`. Mapping `cancelled` onto our `canceled` would cut off paying
 * customers the moment they schedule a cancellation, so this checks the
 * statuses that genuinely revoke instead of trusting the word.
 */
export function isLive(row: ProviderSubscription): boolean {
  const status = (row.providerStatus ?? '').toLowerCase();
  if (status === 'expired' || status === 'canceled') return false;
  // `cancelled` (LS spelling) is still live until ends_at passes.
  if (status === 'cancelled') {
    return row.endsAt ? row.endsAt.getTime() > Date.now() : true;
  }
  return true;
}

/**
 * The add-on quantities a provider believes it is billing for.
 *
 * BILLING, not entitlement. Access checks must read
 * `subscription_items.quantity` instead: the two diverge legitimately when an
 * add-on is reduced mid-cycle, where the provider's figure drops at the
 * renewal boundary while the customer keeps what they paid for until the
 * period ends. This exists for reconciliation — diffing the two to catch
 * webhook drift — never for authorisation.
 */
export function billedQuantities(
  rows: ProviderSubscription[],
): Record<string, number> {
  const provider = pickDefaultProvider(rows);
  if (!provider) return {};

  const out: Record<string, number> = {};
  for (const row of rows) {
    if (row.provider !== provider) continue;
    if (row.itemType === 'BASE_PLAN') continue;
    if (!isLive(row)) continue;
    out[row.itemType] = row.providerQuantity;
  }
  return out;
}
