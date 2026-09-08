import { Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { and, eq } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { providerSubscriptions } from '../../drizzle/schema';
import { rehomeDefault } from '../services/rehome-default.util';

const logger = new Logger('StripeProviderRow');

const PROVIDER = 'stripe' as const;

/**
 * Write the `provider_subscriptions` BASE_PLAN row for a Stripe subscription.
 *
 * WHY THIS EXISTS
 *
 * Migration 0032 created `provider_subscriptions` and six files were changed
 * to READ from it — `hasLiveBasePlan()` is now the discriminator every
 * paid/unpaid branch keys on. Nothing was ever changed to WRITE the BASE_PLAN
 * row: the only INSERT in the codebase was `StripeAdapter.purchaseAddon`,
 * which writes add-on item types.
 *
 * So the table was read by code that decides whether to cancel at the provider
 * and whether an account already pays someone, and it was empty. Migration
 * 0034 backfills the accounts that already exist; this closes the same hole
 * for every subscription created from now on. Without it a subscription
 * created tomorrow reproduces the bug exactly: `downgradeToFree` returns
 * before cancelling (Stripe charges on), and a paid -> paid `changePlan`
 * creates a SECOND live Stripe subscription.
 *
 * IDEMPOTENT by construction. Stripe redelivers webhooks, and
 * `checkout.session.completed` can arrive more than once for one checkout, so
 * this upserts on the `(subscription_id, provider, item_type)` constraint and
 * refreshes the mutable provider facts rather than inserting a duplicate.
 *
 * `is_default` is set to true only on INSERT. On conflict it is deliberately
 * left alone: during the Lemon Squeezy -> Stripe window the flag says which
 * provider currently bills the account, and a redelivered webhook must not
 * silently move it. The partial unique index
 * `provider_subscriptions_one_default_idx` permits one true row per
 * subscription, so flipping it here could also raise 23505.
 *
 * NEVER THROWS. It is called after the customer has already been charged and
 * after the `subscriptions` row has been written; failing the request at that
 * point would leave the caller believing the subscription did not happen. A
 * missing row degrades to the pre-0032 behaviour and the next webhook writes
 * it, so it is logged loudly instead.
 */
export async function writeStripeBasePlanRow(input: {
  /** Our `subscriptions.id`. */
  subscriptionId: number;
  stripeSubscription: Stripe.Subscription;
  stripeCustomerId: string;
  /** Our plan's monthly price, for the billing figure on the row. */
  unitPriceCents?: number;
}): Promise<void> {
  const sub = input.stripeSubscription as unknown as {
    id: string;
    status?: string;
    cancel_at_period_end?: boolean;
    items?: { data?: { id?: string; price?: { id?: string } }[] };
  };

  const baseItem = sub.items?.data?.[0];

  // The renewal/expiry boundary. `isLive()` reads `endsAt`, and a period end
  // is a RENEWAL date rather than an expiry — writing it into `endsAt` for a
  // healthy subscription would make every subscriber read as expired the
  // moment their period rolled over. So it only becomes `endsAt` when Stripe
  // says the subscription actually stops there.
  const periodEnd = readPeriodEnd(input.stripeSubscription);
  const cancelling = Boolean(sub.cancel_at_period_end);

  const values = {
    subscriptionId: input.subscriptionId,
    provider: PROVIDER,
    itemType: 'BASE_PLAN',
    providerSubscriptionId: sub.id,
    providerCustomerId: input.stripeCustomerId,
    providerItemId: baseItem?.id ?? null,
    providerPriceId: baseItem?.price?.id ?? null,
    providerQuantity: 1,
    unitPriceCents: input.unitPriceCents ?? null,
    providerStatus: sub.status ?? null,
    endsAt: cancelling ? periodEnd : null,
    renewsAt: cancelling ? null : periodEnd,
    isDefault: true,
  };

  try {
    await db
      .insert(providerSubscriptions)
      .values(values)
      .onConflictDoUpdate({
        target: [
          providerSubscriptions.subscriptionId,
          providerSubscriptions.provider,
          providerSubscriptions.itemType,
        ],
        set: {
          providerSubscriptionId: values.providerSubscriptionId,
          providerCustomerId: values.providerCustomerId,
          providerItemId: values.providerItemId,
          providerPriceId: values.providerPriceId,
          unitPriceCents: values.unitPriceCents,
          providerStatus: values.providerStatus,
          endsAt: values.endsAt,
          renewsAt: values.renewsAt,
          updatedAt: new Date(),
        },
      });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      `Failed to write the Stripe BASE_PLAN provider row for subscription ` +
        `${input.subscriptionId} (${sub.id}): ${message}. The account will ` +
        `read as unbilled until a webhook rewrites it — do not let this pass ` +
        `silently.`,
    );
  }
}

/**
 * Mark this account's Stripe provider rows as no longer billing.
 *
 * The counterpart to `clearStaleStripeSubscription`, which nulls
 * `subscriptions.stripe_subscription_id` so the caller falls back to Checkout.
 * That column is no longer what the branches read — `hasLiveBasePlan()` reads
 * `provider_subscriptions` — so clearing one without the other left the
 * recovery path dead: the branch still saw a live base plan, called
 * `stripe.updateSubscription` with the same dead id, and 500'd with
 * `resource_missing`, which is the exact crash the util exists to prevent.
 *
 * `expired` rather than a delete: the row is a record of what a provider
 * held, and `isLive()` already treats `expired` as not billing. Deleting it
 * would lose the audit trail of an id Stripe once issued.
 *
 * Scoped to `provider = 'stripe'`. During the migration window an account can
 * hold live Lemon Squeezy rows alongside its Stripe ones, and a Stripe id
 * having gone stale says nothing about them.
 */
export async function expireStripeProviderRows(
  subscriptionId: number,
): Promise<void> {
  await db
    .update(providerSubscriptions)
    .set({ providerStatus: 'expired', updatedAt: new Date() })
    .where(
      and(
        eq(providerSubscriptions.subscriptionId, subscriptionId),
        eq(providerSubscriptions.provider, PROVIDER),
      ),
    );
}

/**
 * The current period end of a Stripe subscription.
 *
 * Stripe API `2025-12-15.clover` removed the top-level
 * `current_period_end`; it now lives on each subscription item. Reads the item
 * first and falls back to the legacy field.
 */
function readPeriodEnd(stripeSubscription: Stripe.Subscription): Date | null {
  const sub = stripeSubscription as unknown as {
    current_period_end?: number;
    items?: { data?: { current_period_end?: number }[] };
  };
  const endUnix =
    sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end;
  return endUnix ? new Date(endUnix * 1000) : null;
}

/**
 * Refresh the mutable billing facts on an account's Stripe BASE_PLAN row from
 * a Stripe subscription object, WITHOUT creating one.
 *
 * For `customer.subscription.updated`, which is the event that carries every
 * status transition Stripe makes on its own: a dunning failure moving
 * `active` -> `past_due`, a recovery moving back, a cancellation scheduled
 * from the Stripe Dashboard setting `cancel_at_period_end`, a trial
 * converting, a renewal moving the period bounds.
 *
 * That handler used to write `status`, `cancelAtPeriodEnd` and the period
 * bounds to `subscriptions` and stop there. `isLive()` and `hasLiveBasePlan()`
 * read `provider_subscriptions.provider_status` / `ends_at`, so the two tables
 * holding the same fact drifted apart the moment Stripe changed anything
 * outside our own API calls — the identical shape as the round-1 defect, on a
 * different pair of columns. A cancellation scheduled in the Dashboard left
 * the provider row saying `active` with no `ends_at`, so the branch that
 * decides whether to cancel at the provider was answering from data that had
 * stopped tracking Stripe.
 *
 * UPDATE, never upsert. `customer.subscription.updated` fires for
 * subscriptions we may not own a row for at all (an account mid-Checkout whose
 * `checkout.session.completed` has not landed yet — Stripe does not guarantee
 * event ordering). Inserting here would claim `is_default = true` for an
 * account whose provider is not yet decided, and during the Lemon Squeezy
 * overlap that flag is the cutover mechanism. Zero rows matched is the correct
 * outcome; `handleCheckoutSessionCompleted` writes the row and a later
 * `updated` refreshes it.
 *
 * NEVER THROWS, for the same reason as `writeStripeBasePlanRow`: a webhook
 * that 500s is retried by Stripe, and failing the whole delivery over a
 * bookkeeping refresh would also roll back the `subscriptions` write that
 * already succeeded.
 */
export async function refreshStripeProviderRowStatus(input: {
  /** Our `subscriptions.id`. */
  subscriptionId: number;
  stripeSubscription: Stripe.Subscription;
}): Promise<void> {
  const sub = input.stripeSubscription as unknown as {
    id: string;
    status?: string;
    cancel_at_period_end?: boolean;
  };

  // Same rule as the writer: a period end is a RENEWAL date unless Stripe says
  // the subscription actually stops there. Writing it into `endsAt`
  // unconditionally would make every healthy subscriber read as expired the
  // moment their period rolled over.
  const periodEnd = readPeriodEnd(input.stripeSubscription);
  const cancelling = Boolean(sub.cancel_at_period_end);

  try {
    await db
      .update(providerSubscriptions)
      .set({
        providerStatus: sub.status ?? null,
        endsAt: cancelling ? periodEnd : null,
        renewsAt: cancelling ? null : periodEnd,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(providerSubscriptions.subscriptionId, input.subscriptionId),
          eq(providerSubscriptions.provider, PROVIDER),
          eq(providerSubscriptions.itemType, 'BASE_PLAN'),
        ),
      );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      `Failed to refresh the Stripe BASE_PLAN provider row for subscription ` +
        `${input.subscriptionId} (${sub.id}): ${message}. Its provider_status ` +
        `is now stale relative to Stripe.`,
    );
  }
}

/**
 * End an account's Stripe provider rows because Stripe says the subscription
 * is gone for good (`customer.subscription.deleted`).
 *
 * WHY THIS IS NOT `expireStripeProviderRows`
 *
 * Both mark the rows dead, and `isLive()` treats `expired` and `canceled`
 * alike. The difference is `is_default`, and it is the whole point of this
 * function. That flag names the provider currently billing the account, and
 * the partial unique index `provider_subscriptions_one_default_idx` allows
 * exactly ONE true row per subscription. A dead Stripe row that keeps the flag
 * is squatting on the single slot: when the account later subscribes through
 * Lemon Squeezy, claiming it raises 23505 — AFTER Lemon Squeezy has taken the
 * customer's money.
 *
 * `expireStripeProviderRows` deliberately leaves the flag alone because it
 * runs on a stale-id recovery where the account is expected to re-subscribe
 * through Stripe immediately. Here the subscription has genuinely ended and
 * the account is FREE, so nothing owns the slot.
 *
 * WHAT WENT WRONG WITHOUT IT
 *
 * `handleSubscriptionDeleted` nulled `subscriptions.stripe_subscription_id`,
 * set the plan to FREE and deleted the `subscription_items` — and left the
 * BASE_PLAN provider row at `provider_status = 'active'`, `is_default = true`.
 * The account then read as FREE locally while holding a live-looking row
 * naming a subscription Stripe had already deleted. On the customer's next
 * attempt to re-subscribe, `hasLiveBasePlan()` returned TRUE (a row exists, so
 * the legacy fallback never ran), `changePlan` took the already-paying branch,
 * and the adapter handed Stripe the dead id — `resource_missing`, an uncaught
 * 500, on every attempt. The customer could not re-subscribe at all.
 *
 * `clearStaleStripeSubscription` could not rescue it either: it early-returns
 * on a null `stripeSubscriptionId`, which this handler had already nulled.
 *
 * AND IT MUST RE-HOME THE FLAG, NOT ONLY RELEASE IT.
 *
 * The UPDATE is scoped to `provider = 'stripe'`, so a live LEMON SQUEEZY row
 * survives it completely untouched — the account is still being billed. This
 * released the flag and handed it to nobody, which is the SEVENTH incarnation
 * of this branch's recurring defect and the exact MIRROR of the sixth: we
 * fixed the Lemon Squeezy direction in `f331109` and left this one open. The
 * resulting state is ZERO defaults while Lemon Squeezy actively bills, so
 * `pickDefaultProvider` returns null, `findItem` returns null (it scopes to
 * the default), `hasLiveBasePlan` answers FALSE for a paying customer, and
 * `plan-change.service.ts` takes its FREE->paid branch: a SECOND live
 * subscription on a customer who is already being charged. The legacy fallback
 * cannot rescue it either — `hasAnyStripeRow` is true, so it returns false
 * before reaching `isRealStripeSubscriptionId`.
 *
 * Reachable from `customer.subscription.deleted` on any account mid-cutover,
 * and from `POST /billing/reset` on any account holding both providers.
 *
 * ORDERING IS LOAD-BEARING and it is why the re-home is a SECOND statement
 * rather than part of the UPDATE. By the time it runs, every Stripe row on the
 * account reads `canceled`, so `rehomeDefault`'s real `isLive` filter rejects
 * them all and only a genuinely live cross-provider row can inherit. Running
 * it first would let a Stripe row this same call is about to kill win the heir
 * search and take the flag to its grave.
 *
 * NEVER THROWS — a webhook retry storm is worse than a stale flag, and the
 * `subscriptions` write has already committed by the time this runs.
 * `rehomeDefault` is itself non-throwing for the same reason.
 */
export async function endStripeProviderRows(
  subscriptionId: number,
): Promise<void> {
  try {
    await db
      .update(providerSubscriptions)
      .set({
        providerStatus: 'canceled',
        isDefault: false,
        endsAt: new Date(),
        renewsAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(providerSubscriptions.subscriptionId, subscriptionId),
          eq(providerSubscriptions.provider, PROVIDER),
        ),
      );

    // AFTER the rows above are already `canceled`, never before. See the
    // ordering paragraph in the doc comment: the heir search filters on the
    // real `isLive`, so running it earlier would let a Stripe row this same
    // call is about to kill look live and inherit the flag.
    await rehomeDefault({ subscriptionId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      `Failed to end the Stripe provider rows for subscription ` +
        `${subscriptionId}: ${message}. The account may read as still billed ` +
        `and its is_default slot may block a future Lemon Squeezy signup.`,
    );
  }
}
