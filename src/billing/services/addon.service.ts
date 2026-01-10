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
  NewSubscriptionItem,
  NewSubscriptionChange,
} from '../../drizzle/schema';
import { StripeService } from '../../stripe/stripe.service';
import { UsageService } from './usage.service';

export type AddonType = 'EXTRA_CHANNEL' | 'EXTRA_MEMBER' | 'EXTRA_WORKSPACE';

export interface PurchaseAddonDto {
  workspaceId: string;
  userId: string;
  addonType: AddonType;
  quantity: number;
}

export interface AddonPurchaseResult {
  subscriptionItemId: number;
  stripeSubscriptionItemId: string;
  addonType: AddonType;
  quantity: number;
  unitPriceCents: number;
  totalPriceCents: number;
  newLimits: {
    channelsLimit?: number;
    membersLimit?: number;
  };
}

@Injectable()
export class AddonService {
  private readonly logger = new Logger(AddonService.name);

  constructor(
    private stripeService: StripeService,
    private usageService: UsageService,
  ) {}

  // Purchase add-on for a workspace
  async purchaseAddon(dto: PurchaseAddonDto): Promise<AddonPurchaseResult> {
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

    // 2. Get active subscription for this workspace
    const subscription = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.workspaceId, workspaceId),
          eq(subscriptions.status, 'active'),
        ),
      )
      .limit(1);

    if (subscription.length === 0) {
      throw new NotFoundException('No active subscription found for this workspace');
    }

    const sub = subscription[0];

    // FREE plan cannot have add-ons
    if (sub.planCode === 'FREE') {
      throw new BadRequestException(
        'Add-ons are not available for FREE plan. Please upgrade to PRO or MAX.',
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

    let stripeSubscriptionItemId: string;
    let subscriptionItemId: number;
    let finalQuantity = quantity;

    if (existingItem.length > 0) {
      // Update existing item - add to current quantity
      finalQuantity = existingItem[0].quantity + quantity;

      if (addonPrice.maxQuantity && finalQuantity > addonPrice.maxQuantity) {
        throw new BadRequestException(
          `Cannot add ${quantity} more. Maximum total for ${addonType} is ${addonPrice.maxQuantity}. ` +
            `You currently have ${existingItem[0].quantity}.`,
        );
      }

      // Update in Stripe
      if (existingItem[0].stripeSubscriptionItemId) {
        await this.stripeService.updateSubscriptionItem(
          existingItem[0].stripeSubscriptionItemId,
          finalQuantity,
        );
        stripeSubscriptionItemId = existingItem[0].stripeSubscriptionItemId;
      } else {
        // Create new Stripe item if none exists
        const stripeItem = await this.stripeService.addSubscriptionItem({
          subscriptionId: sub.stripeSubscriptionId!,
          priceId: addonPrice.stripePriceId,
          quantity: finalQuantity,
        });
        stripeSubscriptionItemId = stripeItem.id;
      }

      // Update in database
      await db
        .update(subscriptionItems)
        .set({
          quantity: finalQuantity,
          stripeSubscriptionItemId,
          updatedAt: new Date(),
        })
        .where(eq(subscriptionItems.id, existingItem[0].id));

      subscriptionItemId = existingItem[0].id;
    } else {
      // Create new subscription item in Stripe
      const stripeItem = await this.stripeService.addSubscriptionItem({
        subscriptionId: sub.stripeSubscriptionId!,
        priceId: addonPrice.stripePriceId,
        quantity,
      });

      stripeSubscriptionItemId = stripeItem.id;

      // Create in database
      const [newItem] = await db
        .insert(subscriptionItems)
        .values({
          subscriptionId: sub.id,
          stripeSubscriptionItemId,
          itemType: addonType,
          stripePriceId: addonPrice.stripePriceId,
          quantity,
          unitPriceCents: addonPrice.pricePerUnitCents,
        } as NewSubscriptionItem)
        .returning();

      subscriptionItemId = newItem.id;
    }

    // 5. Update workspace usage limits
    await this.updateUsageLimitsForAddon(workspaceId, addonType, finalQuantity);

    // 6. Log subscription change
    await db.insert(subscriptionChanges).values({
      subscriptionId: sub.id,
      changeType: existingItem.length > 0 ? 'ADDON_UPDATED' : 'ADDON_ADDED',
      oldValue: existingItem.length > 0 ? { quantity: existingItem[0].quantity } : null,
      newValue: { addonType, quantity: finalQuantity },
      prorationAmountCents: addonPrice.pricePerUnitCents * quantity,
      changedByUserId: userId,
      reason: `Purchased ${quantity} ${addonType}`,
    } as NewSubscriptionChange);

    this.logger.log(
      `Add-on purchased: ${addonType} x${quantity} for workspace ${workspaceId}`,
    );

    // Get updated limits
    const usage = await this.usageService.getWorkspaceUsage(workspaceId);

    return {
      subscriptionItemId,
      stripeSubscriptionItemId,
      addonType,
      quantity: finalQuantity,
      unitPriceCents: addonPrice.pricePerUnitCents,
      totalPriceCents: addonPrice.pricePerUnitCents * finalQuantity,
      newLimits: {
        channelsLimit: usage.channelsLimit,
        membersLimit: usage.membersLimit,
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

    // 2. Get subscription
    const subscription = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.workspaceId, workspaceId),
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

    // 4. Check if removal would violate current usage
    const usage = await db
      .select()
      .from(workspaceUsage)
      .where(eq(workspaceUsage.workspaceId, workspaceId))
      .limit(1);

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

    // 5. Update or delete in Stripe and database
    if (remainingQuantity === 0) {
      // Delete the item entirely
      if (item.stripeSubscriptionItemId) {
        await this.stripeService.deleteSubscriptionItem(item.stripeSubscriptionItemId);
      }

      await db
        .delete(subscriptionItems)
        .where(eq(subscriptionItems.id, item.id));
    } else {
      // Update quantity
      if (item.stripeSubscriptionItemId) {
        await this.stripeService.updateSubscriptionItem(
          item.stripeSubscriptionItemId,
          remainingQuantity,
        );
      }

      await db
        .update(subscriptionItems)
        .set({
          quantity: remainingQuantity,
          updatedAt: new Date(),
        })
        .where(eq(subscriptionItems.id, item.id));
    }

    // 6. Update workspace usage limits
    await this.updateUsageLimitsForAddon(workspaceId, addonType, remainingQuantity);

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
      message: remainingQuantity === 0
        ? `${addonType} add-on removed completely`
        : `Removed ${removeQty} ${addonType}. ${remainingQuantity} remaining.`,
      remainingQuantity,
    };
  }

  // Get available add-ons for a workspace's current plan
  async getAvailableAddons(workspaceId: string): Promise<any[]> {
    const subscription = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.workspaceId, workspaceId),
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
      minQuantity: addon.minQuantity,
      maxQuantity: addon.maxQuantity,
      currentQuantity: itemMap.get(addon.addonType) || 0,
    }));
  }

  // Get current add-ons for a workspace
  async getCurrentAddons(workspaceId: string): Promise<any[]> {
    const subscription = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.workspaceId, workspaceId),
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

  // Helper to update usage limits when add-ons change
  private async updateUsageLimitsForAddon(
    workspaceId: string,
    addonType: AddonType,
    newQuantity: number,
  ): Promise<void> {
    const updates: Record<string, number> = {};

    if (addonType === 'EXTRA_CHANNEL') {
      updates['extraChannelsPurchased'] = newQuantity;
    } else if (addonType === 'EXTRA_MEMBER') {
      updates['extraMembersPurchased'] = newQuantity;
    }

    if (Object.keys(updates).length > 0) {
      await this.usageService.updateWorkspaceLimits(workspaceId, updates);
    }
  }
}
