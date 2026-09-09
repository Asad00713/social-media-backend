import type Stripe from 'stripe';
import { PlanLimits, AddonQuantities } from './limit-resolver.util';
import {
  buildUsageFanout,
  WorkspaceRef,
  WorkspaceLimitWrite,
} from './usage-fanout.util';

export interface SubscriptionSyncInput {
  userId: string;
  /** Every workspace the account owns — limits fan out across all of them. */
  workspaces: WorkspaceRef[];
  planCode: string;
  plan: PlanLimits & { basePriceCents: number };
  addons: AddonQuantities;
  stripeCustomerId: string;
  stripeSubscription: Stripe.Subscription;
}

export interface SubscriptionSyncValues {
  subscriptionRow: Record<string, unknown>;
  baseItem: Record<string, unknown>;
  /** One row per owned workspace. Was a single row under workspace billing. */
  usageRows: (WorkspaceLimitWrite & Record<string, unknown>)[];
}

/**
 * Read the current billing period from a Stripe subscription.
 *
 * Stripe API `2025-12-15.clover` removed the top-level
 * `subscription.current_period_start/end`; they now live on each subscription
 * item (`items.data[].current_period_*`). We read the item first and fall back
 * to the legacy top-level fields for safety. Returns `null` when unavailable.
 */
export function getSubscriptionPeriod(stripeSubscription: Stripe.Subscription): {
  start: Date | null;
  end: Date | null;
} {
  const sub = stripeSubscription as any;
  const item = sub.items?.data?.[0];
  const startUnix = item?.current_period_start ?? sub.current_period_start;
  const endUnix = item?.current_period_end ?? sub.current_period_end;
  return {
    start: startUnix ? new Date(startUnix * 1000) : null,
    end: endUnix ? new Date(endUnix * 1000) : null,
  };
}

/**
 * Pure mapping from a Stripe subscription + our plan into the DB row values
 * used to upsert `subscriptions`, the BASE_PLAN `subscription_items` row, and
 * `workspace_usage` (one row per owned workspace). No DB access —
 * unit-testable. Null timestamps are omitted (Drizzle rejects explicit null
 * for timestamp columns).
 */
export function buildSubscriptionSync(
  input: SubscriptionSyncInput,
): SubscriptionSyncValues {
  const sub = input.stripeSubscription as any;
  const baseStripeItem = sub.items?.data?.[0];
  const period = getSubscriptionPeriod(input.stripeSubscription);

  const subscriptionRow: Record<string, unknown> = {
    userId: input.userId,
    stripeCustomerId: input.stripeCustomerId,
    stripeSubscriptionId: sub.id,
    planCode: input.planCode,
    status: sub.status,
    currentPeriodStart: period.start ?? new Date(),
    currentPeriodEnd: period.end,
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

  // Mirror createFreeSubscription's defaults for NOT-NULL count fields so an
  // upsert-insert (no workspace_usage row yet) satisfies every constraint.
  const usageRows = buildUsageFanout(
    input.workspaces,
    input.plan,
    input.addons,
  ).map((write) => ({
    ...write,
    channelsCount: 0,
    extraChannelsPurchased: 0,
    membersCount: 0,
    extraMembersPurchased: 0,
  }));

  return { subscriptionRow, baseItem, usageRows };
}
