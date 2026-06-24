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

  // Mirror createFreeSubscription's defaults for NOT-NULL count fields so that
  // an upsert-insert (when no workspace_usage row exists yet) satisfies all
  // NOT-NULL constraints without a DB default.
  const usageRow: Record<string, unknown> = {
    workspaceId: input.workspaceId,
    channelsLimit: input.plan.channelsPerWorkspace,
    membersLimit: input.plan.membersPerWorkspace,
    aiTokensLimit: input.plan.aiTokensPerMonth,
    channelsCount: 0,
    extraChannelsPurchased: 0,
    membersCount: 0,
    extraMembersPurchased: 0,
  };

  return { subscriptionRow, baseItem, usageRow };
}
