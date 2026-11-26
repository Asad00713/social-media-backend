import { Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import {
  providerSubscriptions,
  subscriptionItems,
  subscriptions,
  ProviderItemType,
  PaymentProvider,
} from '../../drizzle/schema';

/**
 * Taking entitlements back when a provider stops billing for them.
 *
 * Lifted out of `lemonsqueezy-webhook.service.ts`, where both functions were
 * private, so the Paddle webhook service does not need a second copy. Neither
 * of them ever read a Lemon Squeezy field — the only provider-specific things
 * were the `provider` column filter and the wording of a log line, so both are
 * now arguments.
 *
 * It is one shared function per fact rather than two near-identical ones,
 * because the invariants here have broken twice on this repo already — a
 * removed add-on that went on reading as live billing, and an `is_default`
 * flag released without being handed on. A bug found in one copy is a bug
 * still live in the other, and the second copy is the one nobody remembers to
 * check.
 *
 * `rehomeDefault` is NOT called from here. It must run at a point only the
 * caller knows — after the dying rows have been marked dead, or the heir
 * search picks one of them — so the ordering stays visible in the webhook
 * service that owns it.
 */

const logger = new Logger('RevokeEntitlements');

/** The item types that are add-ons rather than the plan itself. */
export const ADDON_ITEM_TYPES: ProviderItemType[] = [
  'EXTRA_CHANNEL',
  'EXTRA_MEMBER',
  'EXTRA_WORKSPACE',
  'EXTRA_AI_TOKENS',
];

/** What the caller must give us to re-apply an account's limits. */
export interface LimitsApplier {
  applyLimitsToAllWorkspaces(
    userId: string,
    planCode: string,
    addons: {
      extraChannels: number;
      extraMembers: number;
      extraWorkspaces: number;
      extraAiTokens: number;
    },
  ): Promise<unknown>;
  getAddonQuantities(subscriptionId: number): Promise<{
    extraChannels: number;
    extraMembers: number;
    extraWorkspaces: number;
    extraAiTokens: number;
  }>;
}

/**
 * The base plan has ended: the account falls back to FREE everywhere.
 *
 * The BASE_PLAN provider row must already be dead and de-defaulted by the
 * caller; this closes the rest — the add-on bookkeeping rows, the workspace
 * limits, and the sibling provider rows that would otherwise go on reading as
 * live billing. Without it the account keeps its paid limits forever while the
 * provider bills nothing.
 *
 * Scoped to ONE provider on purpose. A cutover account can hold live rows at
 * another provider, and a base plan lapsing at the provider the customer LEFT
 * must not touch the one now charging them.
 */
export async function revokeBasePlan(input: {
  provider: PaymentProvider;
  subscriptionId: number;
  limits: LimitsApplier;
}): Promise<void> {
  const { provider, subscriptionId, limits } = input;

  const sub = (await db
    .select({ userId: subscriptions.userId })
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId))) as { userId: string }[];

  const userId = sub[0]?.userId;
  if (!userId) return;

  // The add-on items are deleted just below, so zeroes are passed explicitly
  // rather than reading quantities that are about to disappear.
  await limits.applyLimitsToAllWorkspaces(userId, 'FREE', {
    extraChannels: 0,
    extraMembers: 0,
    extraWorkspaces: 0,
    extraAiTokens: 0,
  });

  await db
    .delete(subscriptionItems)
    .where(eq(subscriptionItems.subscriptionId, subscriptionId));

  // Nothing is entitled by the add-ons any more, and their rows would
  // otherwise go on reading as live billing. Mark them dead and release any
  // default flag they hold, so the account can subscribe again through any
  // provider.
  await db
    .update(providerSubscriptions)
    .set({
      providerStatus: 'expired',
      isDefault: false,
      renewsAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(providerSubscriptions.subscriptionId, subscriptionId),
        eq(providerSubscriptions.provider, provider),
      ),
    );

  logger.log(
    `User ${userId} reset to FREE after their ${provider} subscription ended`,
  );
}

/**
 * One add-on has ended: its bookkeeping row goes and the account's limits are
 * recomputed from whatever is still paid for.
 *
 * `subscription_items` is what the rest of the app reads for quantities, so
 * leaving the row in place keeps granting capacity nobody pays for — the
 * entitlement mirror of billing after a cancel.
 *
 * Does nothing for a non-add-on item type, so a caller that reaches it with a
 * BASE_PLAN target cannot accidentally strip a live plan's limits.
 */
export async function revokeAddon(input: {
  subscriptionId: number;
  itemType: string;
  limits: LimitsApplier;
}): Promise<void> {
  const { subscriptionId, itemType, limits } = input;

  if (!ADDON_ITEM_TYPES.includes(itemType as ProviderItemType)) return;

  await db
    .delete(subscriptionItems)
    .where(
      and(
        eq(subscriptionItems.subscriptionId, subscriptionId),
        eq(subscriptionItems.itemType, itemType),
      ),
    );

  const sub = (await db
    .select({
      userId: subscriptions.userId,
      planCode: subscriptions.planCode,
    })
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId))) as {
    userId: string;
    planCode: string;
  }[];

  const account = sub[0];
  if (!account) return;

  // Read AFTER the delete: the quantities that remain are what the account is
  // still entitled to.
  const addons = await limits.getAddonQuantities(subscriptionId);
  await limits.applyLimitsToAllWorkspaces(
    account.userId,
    account.planCode,
    addons,
  );
}
