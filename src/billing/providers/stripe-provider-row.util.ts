import { Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { and, eq } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { providerSubscriptions } from '../../drizzle/schema';

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
