import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import {
  subscriptions,
  subscriptionItems,
  addonPricing,
  workspaceUsage,
  subscriptionChanges,
  workspace,
  providerSubscriptions,
  ProviderSubscription,
  NewSubscriptionItem,
  NewSubscriptionChange,
} from '../../drizzle/schema';
import { StripeService } from '../../stripe/stripe.service';
import { UsageService } from './usage.service';
import { SubscriptionLookupService } from './subscription-lookup.service';
import { findItem } from './provider-subscription.util';
import { ProviderRegistryService } from '../providers/provider-registry.service';
import { isCheckoutRequired } from '../providers/payment-provider.interface';
import { assertStripeSubscriptionExists } from '../providers/stripe-stale-subscription.util';

export type AddonType =
  | 'EXTRA_CHANNEL'
  | 'EXTRA_MEMBER'
  | 'EXTRA_WORKSPACE'
  | 'EXTRA_AI_TOKENS';

export interface PurchaseAddonDto {
  workspaceId: string;
  userId: string;
  addonType: AddonType;
  quantity: number;
}

export interface AddonPurchaseResult {
  status: 'completed';
  subscriptionItemId: number;
  stripeSubscriptionItemId: string;
  addonType: AddonType;
  quantity: number;
  unitPriceCents: number;
  totalPriceCents: number;
  newLimits: {
    channelsLimit?: number;
    membersLimit?: number;
    aiTokensLimit?: number;
  };
}

/**
 * A brand-new Lemon Squeezy add-on cannot be created through their API - there
 * is no `POST /v1/subscription-items` - so it has to start at a hosted
 * checkout and completes later via webhook.
 *
 * Surfaced as its own variant rather than a thrown error or a silent no-op:
 * the caller must redirect, and a discriminated union is what forces the
 * frontend to handle it instead of reading `quantity` off a purchase that has
 * not happened yet. Limits are NOT moved here - the webhook does that when the
 * customer actually pays.
 */
export interface AddonCheckoutRequired {
  status: 'checkout_required';
  addonType: AddonType;
  quantity: number;
  checkoutUrl: string;
}

export type PurchaseAddonOutcome = AddonPurchaseResult | AddonCheckoutRequired;

@Injectable()
export class AddonService {
  private readonly logger = new Logger(AddonService.name);

  constructor(
    private stripeService: StripeService,
    private usageService: UsageService,
    private readonly lookup: SubscriptionLookupService,
    private readonly providers: ProviderRegistryService,
  ) {}

  // Purchase add-on for a workspace
  async purchaseAddon(dto: PurchaseAddonDto): Promise<PurchaseAddonOutcome> {
    const { workspaceId, userId, addonType, quantity } = dto;

    if (quantity < 1) {
      throw new BadRequestException('Quantity must be at least 1');
    }

    // 1. Get workspace and verify ownership
    const ws = await db
      .select()
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1);

    if (ws.length === 0) {
      throw new NotFoundException('Workspace not found');
    }

    if (ws[0].ownerId !== userId) {
      throw new ForbiddenException('Only workspace owner can purchase add-ons');
    }

    // 2. Get the account's active subscription. Ownership was just verified,
    //    so `userId` IS the owner whose subscription pays for this workspace.
    const subscription = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, userId),
          eq(subscriptions.status, 'active'),
        ),
      )
      .limit(1);

    if (subscription.length === 0) {
      throw new NotFoundException(
        'No active subscription found for this workspace',
      );
    }

    const sub = subscription[0];

    // FREE plan cannot have add-ons
    if (sub.planCode === 'FREE') {
      throw new BadRequestException(
        'Add-ons are not available for FREE plan. Please upgrade to PRO or MAX.',
      );
    }

    // Which provider bills this account decides everything below.
    const adapter = await this.providers.adapterForSubscription(sub.id);

    // Defensive, Stripe only: the DB might reference a Stripe subscription
    // that no longer exists (test data wiped, account changed, mode switched
    // between test and live). Verify BEFORE we try to mutate it — gives the
    // user a clear actionable error instead of a generic 500.
    if (adapter.name === 'stripe') {
      await assertStripeSubscriptionExists(
        this.stripeService,
        sub,
        `workspace ${workspaceId}`,
      );
    }

    // 3. Get addon pricing for this plan
    const pricing = await db
      .select()
      .from(addonPricing)
      .where(
        and(
          eq(addonPricing.planCode, sub.planCode),
          eq(addonPricing.addonType, addonType),
          eq(addonPricing.isActive, true),
        ),
      )
      .limit(1);

    if (pricing.length === 0) {
      throw new NotFoundException(
        `Add-on ${addonType} is not available for ${sub.planCode} plan`,
      );
    }

    const addonPrice = pricing[0];

    // Check quantity limits
    if (addonPrice.minQuantity && quantity < addonPrice.minQuantity) {
      throw new BadRequestException(
        `Minimum quantity for ${addonType} is ${addonPrice.minQuantity}`,
      );
    }

    if (addonPrice.maxQuantity && quantity > addonPrice.maxQuantity) {
      throw new BadRequestException(
        `Maximum quantity for ${addonType} is ${addonPrice.maxQuantity}`,
      );
    }

    // 3.5 The provider-specific price reference (Stripe price id / Lemon
    //     Squeezy variant id) is resolved inside the adapter via the
    //     catalogue. Reading `stripePriceId` here would have made every Lemon
    //     Squeezy add-on fail on a column that provider never populates. It is
    //     still read below, but only to keep the legacy `subscription_items`
    //     bookkeeping row truthful.
    const stripePriceId = addonPrice.stripePriceId;

    // 4. Check if subscription item already exists for this addon type
    const existingItem = await db
      .select()
      .from(subscriptionItems)
      .where(
        and(
          eq(subscriptionItems.subscriptionId, sub.id),
          eq(subscriptionItems.itemType, addonType),
        ),
      )
      .limit(1);

    let subscriptionItemId: number;
    let finalQuantity = quantity;

    if (existingItem.length > 0) {
      // Add to the current quantity rather than replacing it.
      finalQuantity = existingItem[0].quantity + quantity;

      if (addonPrice.maxQuantity && finalQuantity > addonPrice.maxQuantity) {
        throw new BadRequestException(
          `Cannot add ${quantity} more. Maximum total for ${addonType} is ${addonPrice.maxQuantity}. ` +
            `You currently have ${existingItem[0].quantity}.`,
        );
      }
    }

    // Buy at whichever provider bills this account. `purchaseAddon` covers
    // both "already have this add-on, raise the quantity" and "add a new one";
    // the adapter owns that decision because the two providers model it
    // differently - a line item on one subscription vs. a whole separate
    // subscription.
    const purchase = await adapter.purchaseAddon(
      sub.id,
      addonType,
      finalQuantity,
    );

    // Lemon Squeezy cannot create a NEW add-on through its API, so it hands
    // back a hosted-checkout url instead. Nothing has been bought yet: return
    // the url so the frontend can redirect, and leave limits and bookkeeping
    // to the webhook that fires once the customer pays. Writing limits here
    // would grant the add-on to someone who may never complete checkout.
    if (isCheckoutRequired(purchase)) {
      this.logger.log(
        `Add-on ${addonType} x${quantity} for workspace ${workspaceId} needs checkout at ${adapter.name}`,
      );
      return {
        status: 'checkout_required',
        addonType,
        quantity: finalQuantity,
        checkoutUrl: purchase.url,
      };
    }

    // Keep the legacy `subscription_items` bookkeeping row in step. The
    // provider's own item id now lives in `provider_subscriptions`, written by
    // the adapter; this row is what the rest of the app still reads for
    // quantities, so it must not drift.
    const providerRows = await db
      .select()
      .from(providerSubscriptions)
      .where(eq(providerSubscriptions.subscriptionId, sub.id));
    const providerItemId =
      findItem(providerRows as ProviderSubscription[], addonType)
        ?.providerItemId ?? null;

    if (existingItem.length > 0) {
      await db
        .update(subscriptionItems)
        .set({
          quantity: finalQuantity,
          ...(providerItemId
            ? { stripeSubscriptionItemId: providerItemId }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(subscriptionItems.id, existingItem[0].id));

      subscriptionItemId = existingItem[0].id;
    } else {
      const [newItem] = await db
        .insert(subscriptionItems)
        .values({
          subscriptionId: sub.id,
          stripeSubscriptionItemId: providerItemId,
          itemType: addonType,
          stripePriceId: stripePriceId,
          quantity: finalQuantity,
          unitPriceCents: addonPrice.pricePerUnitCents,
        } as NewSubscriptionItem)
        .returning();

      subscriptionItemId = newItem.id;
    }

    // 5. Update usage limits across the account (pack size converts qty →
    //    resource units)
    await this.updateUsageLimitsForAddon(
      userId,
      sub.planCode,
      addonType,
      finalQuantity,
      addonPrice.unitsPerQuantity,
    );

    // 6. Log subscription change
    await db.insert(subscriptionChanges).values({
      subscriptionId: sub.id,
      changeType: existingItem.length > 0 ? 'ADDON_UPDATED' : 'ADDON_ADDED',
      oldValue:
        existingItem.length > 0 ? { quantity: existingItem[0].quantity } : null,
      newValue: { addonType, quantity: finalQuantity },
      // Null, not the full monthly price. Stripe pro-rates a mid-cycle add-on
      // against the days left in the period, so the real charge is only known
      // from the invoice it raises — writing the list price here recorded an
      // amount the customer was never billed. The invoice is the source of truth.
      prorationAmountCents: null,
      changedByUserId: userId,
      reason: `Purchased ${quantity} ${addonType}`,
    } as NewSubscriptionChange);

    this.logger.log(
      `Add-on purchased: ${addonType} x${quantity} for workspace ${workspaceId}`,
    );

    // Report the limits the purchase actually moved. Purchased channels and
    // seats land on the account's primary workspace, so reading the browsed
    // workspace would report 0 and make a successful purchase look inert.
    const usage = await this.usageService.getWorkspaceUsage(
      (await this.lookup.getPrimaryWorkspaceId(userId)) ?? workspaceId,
    );

    return {
      status: 'completed',
      subscriptionItemId,
      stripeSubscriptionItemId: providerItemId ?? '',
      addonType,
      quantity: finalQuantity,
      unitPriceCents: addonPrice.pricePerUnitCents,
      totalPriceCents: addonPrice.pricePerUnitCents * finalQuantity,
      newLimits: {
        channelsLimit: usage.channelsLimit,
        membersLimit: usage.membersLimit,
        aiTokensLimit: usage.aiTokensLimit,
      },
    };
  }

  // Remove add-on from a workspace
  async removeAddon(
    workspaceId: string,
    userId: string,
    addonType: AddonType,
    quantityToRemove?: number,
  ): Promise<{ message: string; remainingQuantity: number }> {
    // 1. Verify ownership
    const ws = await db
      .select()
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1);

    if (ws.length === 0) {
      throw new NotFoundException('Workspace not found');
    }

    if (ws[0].ownerId !== userId) {
      throw new ForbiddenException('Only workspace owner can manage add-ons');
    }

    // 2. Get the account's subscription (ownership verified just above, so
    //    `userId` is the owner).
    const subscription = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, userId),
          eq(subscriptions.status, 'active'),
        ),
      )
      .limit(1);

    if (subscription.length === 0) {
      throw new NotFoundException('No active subscription found');
    }

    const sub = subscription[0];

    // 3. Get existing subscription item
    const existingItem = await db
      .select()
      .from(subscriptionItems)
      .where(
        and(
          eq(subscriptionItems.subscriptionId, sub.id),
          eq(subscriptionItems.itemType, addonType),
        ),
      )
      .limit(1);

    if (existingItem.length === 0) {
      throw new NotFoundException(`No ${addonType} add-on found`);
    }

    const item = existingItem[0];
    const removeQty = quantityToRemove || item.quantity;

    if (removeQty > item.quantity) {
      throw new BadRequestException(
        `Cannot remove ${removeQty}. You only have ${item.quantity} ${addonType}.`,
      );
    }

    // 4. Check if removal would violate current usage. Purchased channels and
    //    seats land ONLY on the account's primary workspace, so that is the
    //    row the removal actually shrinks — reading the browsed workspace here
    //    would compare against limits it never held.
    const primaryWorkspaceId = await this.lookup.getPrimaryWorkspaceId(userId);
    const usage = primaryWorkspaceId
      ? await db
          .select()
          .from(workspaceUsage)
          .where(eq(workspaceUsage.workspaceId, primaryWorkspaceId))
          .limit(1)
      : [];

    if (usage.length > 0) {
      const u = usage[0];

      if (addonType === 'EXTRA_CHANNEL') {
        const baseLimit = u.channelsLimit - u.extraChannelsPurchased;
        const newLimit = baseLimit + (item.quantity - removeQty);
        if (u.channelsCount > newLimit) {
          throw new BadRequestException(
            `Cannot remove ${removeQty} extra channels. You are using ${u.channelsCount} channels ` +
              `and would only have ${newLimit} after removal. Please remove some channels first.`,
          );
        }
      }

      if (addonType === 'EXTRA_MEMBER') {
        const baseLimit = u.membersLimit - u.extraMembersPurchased;
        const newLimit = baseLimit + (item.quantity - removeQty);
        if (u.membersCount > newLimit) {
          throw new BadRequestException(
            `Cannot remove ${removeQty} extra members. You have ${u.membersCount} members ` +
              `and would only have ${newLimit} after removal. Please remove some members first.`,
          );
        }
      }
    }

    const remainingQuantity = item.quantity - removeQty;

    // 5. Update or remove at the provider, then in our own tables. Removing
    //    the last one is `removeAddon` (a line-item delete on Stripe, a
    //    subscription cancel on Lemon Squeezy); a partial reduction is a
    //    quantity change. Credits from either are handled provider-side.
    const adapter = await this.providers.adapterForSubscription(sub.id);

    if (remainingQuantity === 0) {
      await adapter.removeAddon(sub.id, addonType);

      await db
        .delete(subscriptionItems)
        .where(eq(subscriptionItems.id, item.id));
    } else {
      await adapter.changeAddonQuantity(sub.id, addonType, remainingQuantity);

      await db
        .update(subscriptionItems)
        .set({
          quantity: remainingQuantity,
          updatedAt: new Date(),
        })
        .where(eq(subscriptionItems.id, item.id));
    }

    // 6. Update workspace usage limits. Look up the pack size so AI-token
    //    removals subtract tokens (×500), not pack count. Defaults to 1.
    const [removePricing] = await db
      .select({ unitsPerQuantity: addonPricing.unitsPerQuantity })
      .from(addonPricing)
      .where(
        and(
          eq(addonPricing.planCode, sub.planCode),
          eq(addonPricing.addonType, addonType),
        ),
      )
      .limit(1);

    await this.updateUsageLimitsForAddon(
      userId,
      sub.planCode,
      addonType,
      remainingQuantity,
      removePricing?.unitsPerQuantity ?? 1,
    );

    // 7. Log change
    await db.insert(subscriptionChanges).values({
      subscriptionId: sub.id,
      changeType: remainingQuantity === 0 ? 'ADDON_REMOVED' : 'ADDON_UPDATED',
      oldValue: { quantity: item.quantity },
      newValue: { addonType, quantity: remainingQuantity },
      changedByUserId: userId,
      reason: `Removed ${removeQty} ${addonType}`,
    } as NewSubscriptionChange);

    this.logger.log(
      `Add-on removed: ${removeQty} ${addonType} from workspace ${workspaceId}`,
    );

    return {
      message:
        remainingQuantity === 0
          ? `${addonType} add-on removed completely`
          : `Removed ${removeQty} ${addonType}. ${remainingQuantity} remaining.`,
      remainingQuantity,
    };
  }

  // Get available add-ons for a workspace's current plan
  async getAvailableAddons(workspaceId: string): Promise<any[]> {
    // The subscription that pays for this workspace is its owner's.
    const ownerId = await this.lookup.getOwnerId(workspaceId);
    if (!ownerId) {
      return [];
    }

    const subscription = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, ownerId),
          eq(subscriptions.status, 'active'),
        ),
      )
      .limit(1);

    if (subscription.length === 0) {
      return [];
    }

    const planCode = subscription[0].planCode;

    if (planCode === 'FREE') {
      return [];
    }

    const addons = await db
      .select()
      .from(addonPricing)
      .where(
        and(
          eq(addonPricing.planCode, planCode),
          eq(addonPricing.isActive, true),
        ),
      );

    // Get current quantities
    const currentItems = await db
      .select()
      .from(subscriptionItems)
      .where(eq(subscriptionItems.subscriptionId, subscription[0].id));

    const itemMap = new Map(
      currentItems.map((item) => [item.itemType, item.quantity]),
    );

    return addons.map((addon) => ({
      addonType: addon.addonType,
      pricePerUnitCents: addon.pricePerUnitCents,
      pricePerUnitFormatted: `$${(addon.pricePerUnitCents / 100).toFixed(2)}/month`,
      // Resource units granted per purchased quantity (5000 for an AI-token
      // pack, 1 otherwise) — lets the UI show "5000 tokens / $price".
      unitsPerQuantity: addon.unitsPerQuantity,
      minQuantity: addon.minQuantity,
      maxQuantity: addon.maxQuantity,
      currentQuantity: itemMap.get(addon.addonType) || 0,
    }));
  }

  // Get current add-ons for a workspace
  async getCurrentAddons(workspaceId: string): Promise<any[]> {
    // The subscription that pays for this workspace is its owner's.
    const ownerId = await this.lookup.getOwnerId(workspaceId);
    if (!ownerId) {
      return [];
    }

    const subscription = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, ownerId),
          eq(subscriptions.status, 'active'),
        ),
      )
      .limit(1);

    if (subscription.length === 0) {
      return [];
    }

    const items = await db
      .select()
      .from(subscriptionItems)
      .where(
        and(
          eq(subscriptionItems.subscriptionId, subscription[0].id),
          // Exclude BASE_PLAN
        ),
      );

    return items
      .filter((item) => item.itemType !== 'BASE_PLAN')
      .map((item) => ({
        id: item.id,
        addonType: item.itemType,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        totalPriceCents: item.unitPriceCents * item.quantity,
        totalPriceFormatted: `$${((item.unitPriceCents * item.quantity) / 100).toFixed(2)}/month`,
      }));
  }

  /**
   * Re-apply the account's limits after an add-on quantity changes.
   *
   * Two writes, in order:
   *  1. The purchased totals (`extra*Purchased`) land on the account's PRIMARY
   *     workspace only. Channel and seat limits are per-workspace, so spreading
   *     purchases across workspaces — or letting a bought workspace carry the
   *     tier's allowance — would make EXTRA_WORKSPACE a cheaper route to
   *     channels. See resolveWorkspaceLimits.
   *  2. Every owned workspace then re-derives its limits from plan + add-ons.
   *     Writing only one row would strand the others on stale limits.
   *
   * `unitsPerQuantity` converts purchased quantity → granted resource units:
   * 1 for seats/channels/workspaces, 5000 for an AI-token pack. Without it the
   * AI-token limit grew by the pack COUNT (e.g. +1) instead of +5000 tokens.
   */
  private async updateUsageLimitsForAddon(
    userId: string,
    planCode: string,
    addonType: AddonType,
    newQuantity: number,
    unitsPerQuantity = 1,
  ): Promise<void> {
    // EXTRA_WORKSPACE changes `maxWorkspaces`, which `getWorkspaceLimits`
    // computes LIVE from plan + add-on items. It is never materialized into
    // workspace_usage, so there is nothing to write here.
    if (addonType === 'EXTRA_WORKSPACE') {
      return;
    }

    const updates: Record<string, number> = {};

    if (addonType === 'EXTRA_CHANNEL') {
      updates['extraChannelsPurchased'] = newQuantity;
    } else if (addonType === 'EXTRA_MEMBER') {
      updates['extraMembersPurchased'] = newQuantity;
    } else if (addonType === 'EXTRA_AI_TOKENS') {
      updates['extraAiTokensPurchased'] = newQuantity * unitsPerQuantity;
    }

    if (Object.keys(updates).length === 0) {
      return;
    }

    const primaryWorkspaceId = await this.lookup.getPrimaryWorkspaceId(userId);
    if (!primaryWorkspaceId) {
      this.logger.warn(`User ${userId} owns no workspace — no limits to apply`);
      return;
    }

    await this.usageService.updateWorkspaceLimits(primaryWorkspaceId, updates);

    const subscription = await this.lookup.findByUserId(userId);
    const addons = subscription
      ? await this.lookup.getAddonQuantities(subscription.id)
      : {
          extraChannels: 0,
          extraMembers: 0,
          extraWorkspaces: 0,
          extraAiTokens: 0,
        };

    await this.lookup.applyLimitsToAllWorkspaces(userId, planCode, addons);
  }
}
