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
 * Guards against a `free-plan` sentinel appearing in `stripe_subscription_id`.
 *
 * Defensive only — no such row exists. Verified against the source:
 * `createFreeSubscription` OMITS the column entirely (leaving it NULL), and
 * the `'free-plan'` literal at `subscription.service.ts:326` is a field on the
 * RESPONSE object, never persisted. An earlier version of this comment
 * asserted the sentinel WAS written here; it is not, and migration 0034 keeps
 * the matching guards for the same defensive reason.
 *
 * Kept because the cost is one string comparison and the failure it prevents
 * is expensive: a sentinel read as a real id tells `hasLiveBasePlan()` that a
 * FREE account is being billed, and `downgradeToFree` would then try to cancel
 * it at Stripe.
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
 *
 * NO CALLERS OUTSIDE ITS OWN SPEC, and that is now a deliberate answer rather
 * than an oversight. The final review suggested it as the detector for the
 * seventh incarnation — an account whose Stripe rows died while a live Lemon
 * Squeezy row carried on billing. It is not, and wiring it there would have
 * been the wrong shape twice over:
 *
 *  - It reads `pickDefaultProvider` FIRST and returns false when there is no
 *    default at all, which is precisely the broken state. It cannot see the
 *    bug it was proposed to detect.
 *  - The bug is now PREVENTED rather than detected: `rehomeDefault` runs on
 *    every termination path, so the zero-defaults state is not reached and
 *    there is nothing left for a detector to find.
 *
 * Kept because it answers a real question the cutover still needs — "is this
 * account mid-migration, with two providers live at once?" — which is what the
 * deferred reconciliation cron and any dual-provider UI will ask. Delete it
 * only when that question stops being asked.
 */
export function hasLegacyProvider(rows: ProviderSubscription[]): boolean {
  const current = pickDefaultProvider(rows);
  if (!current) return false;
  return rows.some((r) => r.provider !== current && isLive(r));
}

/**
 * Terminal Stripe statuses that must read as not-live even though nothing
 * ever renamed them to our `canceled`/`expired` spellings.
 *
 * `refreshStripeProviderRowStatus` (stripe-provider-row.util.ts) writes
 * Stripe's status string onto `provider_status` RAW — it never maps it onto
 * our vocabulary the way the Lemon Squeezy branch below does. `incomplete` ->
 * `active` -> `past_due` -> `canceled`/`unpaid` all arrive verbatim, and most
 * of them are meant to: `unpaid`, `paused` and `past_due` are recoverable
 * states where the customer keeps access, and the deny-list already lets them
 * through correctly.
 *
 * `incomplete_expired` is the one Stripe status that is BOTH raw-written here
 * and genuinely terminal — Stripe's own docs call it out explicitly: "If the
 * first invoice is not paid within 23 hours, the subscription transitions to
 * `incomplete_expired`. This is a terminal status." It reaches this column
 * without ever passing through `endStripeProviderRows`: Stripe fires
 * `customer.subscription.updated`, not `.deleted`, for that transition, so
 * the row is left with a stale `is_default` slot and a status the deny-list
 * used to wave through as "still billing". `hasLiveBasePlan()` then answers
 * true for a customer who never completed a payment, `changePlan` takes the
 * already-paying branch, and they can never subscribe.
 *
 * `canceled` is Stripe's OWN terminal spelling and is already handled above
 * this list runs. `incomplete` (not `_expired`) is deliberately excluded: it
 * is a live, recoverable pending-payment state for the first 23 hours, and
 * treating it as dead here would strip access from someone whose payment is
 * still processing.
 *
 * `removed` is ours, not Stripe's — `StripeAdapter.removeAddon` used to write
 * it for a deleted subscription line item. Because this is a deny-list that
 * fails OPEN, an unlisted status reads as still billing, so a removed add-on
 * went on reading as live: it fed `billedQuantities`, and it was eligible to
 * inherit `is_default` in `rehomeDefault`'s heir search, which would make an
 * unbilled account read as paying. That writer now writes `canceled` like
 * every other termination path, and this entry covers rows written before the
 * change so they do not stay live forever. Kept as a deny-list entry rather
 * than flipping the function to an allow-list: failing closed here would strip
 * a genuinely-paying customer's plan on any status we had not enumerated,
 * which is the round-1 defect this file exists to prevent.
 */
const STRIPE_TERMINAL_STATUSES = new Set(['incomplete_expired', 'removed']);

/**
 * Is this provider record still entitling the customer to something?
 *
 * The Lemon Squeezy trap lives here. Its `cancelled` does NOT mean access has
 * ended — the subscription runs to `ends_at` and only then becomes `expired`.
 * Their docs are explicit that customers keep access in every status except
 * `expired`. Mapping `cancelled` onto our `canceled` would cut off paying
 * customers the moment they schedule a cancellation, so this checks the
 * statuses that genuinely revoke instead of trusting the word.
 *
 * DENY-LIST BY DESIGN, kept deliberately over an allow-list even after this
 * function gained a second enumerated status. A deny-list fails OPEN: an
 * unrecognised status (a future Stripe or Lemon Squeezy addition, a typo, a
 * provider we haven't integrated yet) reads as still-live, so the worst case
 * is we don't cancel a subscription that should have been cancelled. An
 * allow-list fails CLOSED: the same unrecognised status would read as dead,
 * and `hasLiveBasePlan()` would answer false for a customer who is actively
 * being charged — `downgradeToFree` would then strip their plan locally while
 * the provider keeps billing them, which is the exact defect this file's
 * history (round 1) already produced once. Given that history, failing open
 * is the safer default here, so this stays a deny-list with terminal statuses
 * enumerated explicitly rather than flipping to allow-list semantics.
 */
export function isLive(row: ProviderSubscription): boolean {
  const status = (row.providerStatus ?? '').toLowerCase();
  if (status === 'expired' || status === 'canceled') return false;
  if (STRIPE_TERMINAL_STATUSES.has(status)) return false;
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
 *
 * NO CALLERS OUTSIDE ITS OWN SPEC, and deliberately so: its consumer is the
 * nightly reconciliation cron, which the design doc defers explicitly
 * ("Discrepancies are logged, not auto-corrected" / "Explicitly not doing:
 * auto-correcting reconciliation drift"). The spec also names the mechanism
 * this function IS — "`providerQuantity` (billing) is stored separately from
 * `subscription_items.quantity` (entitlement) — the difference between them
 * *is* the drift signal". So it is unwired-pending-its-consumer, not dead
 * code, and it must not be deleted as unused before that cron is written.
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
