import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import Stripe from 'stripe';
import { db } from '../../drizzle/db';
import {
  subscriptions,
  subscriptionItems,
  plans,
  workspaceUsage,
  subscriptionChanges,
  workspace,
  NewSubscriptionChange,
  NewSubscriptionItem,
} from '../../drizzle/schema';
import { StripeService } from '../../stripe/stripe.service';
import { UsageService } from './usage.service';
import { NotificationEmitterService } from '../../notifications/notification-emitter.service';

export interface PlanChangePreview {
  currentPlan: {
    code: string;
    name: string;
    priceCents: number;
  };
  newPlan: {
    code: string;
    name: string;
    priceCents: number;
  };
  isUpgrade: boolean;
  proratedAmountCents: number;
  effectiveDate: string;
  newLimits: {
    channelsPerWorkspace: number;
    membersPerWorkspace: number;
    maxWorkspaces: number;
  };
  validationIssues: string[];
  canChange: boolean;
}

export interface PlanChangeResult {
  success: boolean;
  subscriptionId: number;
  oldPlan: string;
  newPlan: string;
  isUpgrade: boolean;
  proratedAmountCents: number;
  newLimits: {
    channelsPerWorkspace: number;
    membersPerWorkspace: number;
    maxWorkspaces: number;
  };
}

@Injectable()
export class PlanChangeService {
  private readonly logger = new Logger(PlanChangeService.name);

  // Plan hierarchy for determining upgrade vs downgrade. Must stay in sync with
  // the frontend `PLAN_HIERARCHY` (plan-helpers.ts). A missing tier resolves to
  // `undefined`, which silently breaks every upgrade/downgrade comparison.
  private readonly planHierarchy: Record<string, number> = {
    FREE: 0,
    BASIC: 1,
    PRO: 2,
    MAX: 3,
    ENTERPRISE: 4,
  };

  constructor(
    private stripeService: StripeService,
    private usageService: UsageService,
    private notificationEmitter: NotificationEmitterService,
  ) {}

  // Preview plan change (shows proration, validation issues)
  async previewPlanChange(
    workspaceId: string,
    userId: string,
    newPlanCode: string,
  ): Promise<PlanChangePreview> {
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
      throw new ForbiddenException('Only workspace owner can change plans');
    }

    // 2. Get current subscription
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

    if (sub.planCode === newPlanCode) {
      throw new BadRequestException('Already on this plan');
    }

    // 3. Get current and new plan details
    const [currentPlan, newPlan] = await Promise.all([
      db.select().from(plans).where(eq(plans.code, sub.planCode)).limit(1),
      db.select().from(plans).where(eq(plans.code, newPlanCode)).limit(1),
    ]);

    if (currentPlan.length === 0) {
      throw new NotFoundException('Current plan not found');
    }

    if (newPlan.length === 0) {
      throw new NotFoundException(`Plan ${newPlanCode} not found`);
    }

    const current = currentPlan[0];
    const target = newPlan[0];

    if (!target.isActive) {
      throw new BadRequestException('Target plan is not available');
    }

    // 4. Determine if upgrade or downgrade
    const isUpgrade =
      this.planHierarchy[newPlanCode] > this.planHierarchy[sub.planCode];

    // 5. Validate downgrade (check usage)
    const validationIssues: string[] = [];

    if (!isUpgrade) {
      const downgradeCheck = await this.usageService.canDowngrade(
        workspaceId,
        newPlanCode,
      );
      validationIssues.push(...downgradeCheck.issues);
    }

    // 6. Calculate proration (simplified - Stripe handles actual proration)
    let proratedAmountCents = 0;

    if (sub.stripeSubscriptionId && target.stripePriceId) {
      // Positive = customer pays more, negative = credit
      const priceDiff = target.basePriceCents - current.basePriceCents;

      // Estimate remaining days in period
      if (sub.currentPeriodEnd) {
        const now = new Date();
        const periodEnd = new Date(sub.currentPeriodEnd);
        const totalDays = 30; // Approximate month
        const remainingDays = Math.max(
          0,
          Math.ceil(
            (periodEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
          ),
        );
        const remainingRatio = remainingDays / totalDays;
        proratedAmountCents = Math.round(priceDiff * remainingRatio);
      }
    }

    return {
      currentPlan: {
        code: current.code,
        name: current.name,
        priceCents: current.basePriceCents,
      },
      newPlan: {
        code: target.code,
        name: target.name,
        priceCents: target.basePriceCents,
      },
      isUpgrade,
      proratedAmountCents,
      effectiveDate: isUpgrade ? 'immediate' : 'end_of_period',
      newLimits: {
        channelsPerWorkspace: target.channelsPerWorkspace,
        membersPerWorkspace: target.membersPerWorkspace,
        maxWorkspaces: target.maxWorkspaces,
      },
      validationIssues,
      canChange: validationIssues.length === 0,
    };
  }

  // Execute plan change
  async changePlan(
    workspaceId: string,
    userId: string,
    newPlanCode: string,
    options?: {
      forceDowngrade?: boolean; // Bypass validation (admin use)
      immediateDowngrade?: boolean; // Don't wait for period end
    },
  ): Promise<PlanChangeResult> {
    this.logger.log(
      `[DEBUG] === changePlan START === workspace=${workspaceId}, newPlan=${newPlanCode}`,
    );

    // Downgrades to FREE cancel the Stripe subscription entirely — delegate to
    // the dedicated path (which also defers the cancellation to period end).
    if (newPlanCode === 'FREE') {
      return await this.downgradeToFree(workspaceId, userId);
    }

    // 1. Preview to validate
    this.logger.log(`[DEBUG] Step 1: Getting preview...`);
    const preview = await this.previewPlanChange(
      workspaceId,
      userId,
      newPlanCode,
    );
    this.logger.log(`[DEBUG] Step 1 DONE: canChange=${preview.canChange}`);

    if (!preview.canChange && !options?.forceDowngrade) {
      throw new BadRequestException(
        `Cannot change plan: ${preview.validationIssues.join(', ')}`,
      );
    }

    // 2. Get subscription
    this.logger.log(`[DEBUG] Step 2: Getting subscription...`);
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

    const sub = subscription[0];
    this.logger.log(
      `[DEBUG] Step 2 DONE: sub.id=${sub.id}, stripeSubId=${sub.stripeSubscriptionId}, currentPeriodEnd=${sub.currentPeriodEnd}`,
    );
    const oldPlanCode = sub.planCode;

    // Defensive: the stored stripeSubscriptionId may have been wiped on
    // Stripe's side (test data reset, account switch, mode change). Verify
    // it still exists before we try to mutate it. If it's gone, null it
    // out in our DB and treat as a fresh subscribe — let the user proceed
    // via Checkout instead of crashing.
    if (sub.stripeSubscriptionId) {
      try {
        await this.stripeService.getSubscription(sub.stripeSubscriptionId);
      } catch (err: any) {
        if (err?.code === 'resource_missing') {
          this.logger.warn(
            `Stale stripe_subscription_id ${sub.stripeSubscriptionId} on workspace ${workspaceId} — clearing.`,
          );
          await db
            .update(subscriptions)
            .set({
              stripeSubscriptionId: null,
              status: 'incomplete',
              updatedAt: new Date(),
            })
            .where(eq(subscriptions.id, sub.id));
          // Wipe the in-memory copy so the rest of changePlan treats this
          // as the "no existing Stripe subscription" path (Checkout flow).
          sub.stripeSubscriptionId = null;
        } else {
          throw err;
        }
      }
    }

    // 3. Get new plan
    const newPlan = await db
      .select()
      .from(plans)
      .where(eq(plans.code, newPlanCode))
      .limit(1);

    const target = newPlan[0];

    // 4. Read the provisioned Stripe price for the target plan (read-only).
    //    FREE (basePriceCents === 0) has no price — targetPriceId stays empty
    //    and the downstream `if (sub.stripeSubscriptionId && targetPriceId)`
    //    branch handles the free path.
    const targetPriceId = target.stripePriceId;

    if (!targetPriceId && target.basePriceCents > 0) {
      throw new BadRequestException(
        `Plan "${target.code}" is not provisioned in Stripe — run the pricing provision script (npx ts-node src/drizzle/seeds/stripe-provision.ts)`,
      );
    }

    // DOWNGRADE (paid → lower paid tier): defer to period end. The customer
    // keeps their current plan + limits until `currentPeriodEnd`; we swap the
    // Stripe price now with NO proration (so the next invoice bills the lower
    // price), and the webhook flips our plan/limits once the period rolls over.
    if (!preview.isUpgrade && sub.stripeSubscriptionId && targetPriceId) {
      return await this.scheduleDowngrade(
        sub,
        userId,
        target,
        targetPriceId,
        oldPlanCode,
        preview,
      );
    }

    // 5. Handle Stripe subscription - either update existing or create new
    let newStripeSubscriptionId: string | null = null;
    let newStripeSubscriptionItemId: string | null = null;

    if (sub.stripeSubscriptionId && targetPriceId) {
      // Existing Stripe subscription - update it
      const baseItem = await db
        .select()
        .from(subscriptionItems)
        .where(
          and(
            eq(subscriptionItems.subscriptionId, sub.id),
            eq(subscriptionItems.itemType, 'BASE_PLAN'),
          ),
        )
        .limit(1);

      if (baseItem.length > 0 && baseItem[0].stripeSubscriptionItemId) {
        // Update the subscription item to new price
        const stripeSubscription = await this.stripeService.getSubscription(
          sub.stripeSubscriptionId,
        );

        // Find the item ID in Stripe
        const stripeItem: any = stripeSubscription.items.data.find(
          (item: any) => item.id === baseItem[0].stripeSubscriptionItemId,
        );

        if (stripeItem) {
          await this.stripeService.updateSubscription(
            sub.stripeSubscriptionId,
            {
              items: [
                {
                  id: stripeItem.id,
                  price: targetPriceId,
                },
              ],
              proration_behavior: preview.isUpgrade
                ? 'create_prorations'
                : 'none',
            },
          );

          // For upgrades, charge immediately (industry standard)
          if (preview.isUpgrade) {
            await this.invoiceImmediately(sub.stripeSubscriptionId);
          }
        }
      } else {
        // No existing item, add new one (this will invoice immediately via addSubscriptionItem)
        await this.stripeService.addSubscriptionItem({
          subscriptionId: sub.stripeSubscriptionId,
          priceId: targetPriceId,
          quantity: 1,
        });
      }
    } else if (
      !sub.stripeSubscriptionId &&
      targetPriceId &&
      target.basePriceCents > 0
    ) {
      // Upgrading from FREE plan - need to create a new Stripe subscription
      this.logger.log(
        `Creating new Stripe subscription for upgrade from FREE to ${newPlanCode}`,
      );

      // Guard: FREE→paid upgrade requires a card on file. The Checkout flow
      // attaches the card before the webhook fires; direct calls must be blocked.
      const hasCard = await this.stripeService.customerHasPaymentMethod(
        sub.stripeCustomerId,
      );
      if (!hasCard) {
        throw new BadRequestException(
          'A payment method is required to upgrade to a paid plan — subscribe via Checkout',
        );
      }

      // Create Stripe subscription
      const stripeSubscription = await this.stripeService.createSubscription({
        customerId: sub.stripeCustomerId,
        priceId: targetPriceId,
        metadata: {
          workspaceId,
          userId,
          planCode: newPlanCode,
        },
      });

      newStripeSubscriptionId = stripeSubscription.id;
      newStripeSubscriptionItemId =
        stripeSubscription.items.data[0]?.id || null;

      this.logger.log(
        `Created Stripe subscription ${newStripeSubscriptionId} for workspace ${workspaceId}`,
      );
    }

    // 6. Update subscription in database
    this.logger.log(`[DEBUG] Step 6: Updating subscription in DB...`);
    const subscriptionUpdateData: any = {
      planCode: newPlanCode,
      // Upgrading immediately clears any previously-scheduled downgrade.
      scheduledPlanCode: null,
      scheduledChangeAt: null,
      updatedAt: new Date(),
    };

    // If we created a new Stripe subscription, update those fields too
    if (newStripeSubscriptionId) {
      subscriptionUpdateData.stripeSubscriptionId = newStripeSubscriptionId;
      subscriptionUpdateData.status = 'active';
      subscriptionUpdateData.currentPeriodStart = new Date();
      // Set currentPeriodEnd to 30 days from now (will be updated by webhook)
      subscriptionUpdateData.currentPeriodEnd = new Date(
        Date.now() + 30 * 24 * 60 * 60 * 1000,
      );
    }
    this.logger.log(
      `[DEBUG] Step 6: subscriptionUpdateData = ${JSON.stringify(subscriptionUpdateData)}`,
    );

    await db
      .update(subscriptions)
      .set(subscriptionUpdateData)
      .where(eq(subscriptions.id, sub.id));
    this.logger.log(`[DEBUG] Step 6 DONE`);

    // 7. Update or create base plan subscription item
    this.logger.log(`[DEBUG] Step 7: Updating subscription items...`);
    const existingBaseItem = await db
      .select()
      .from(subscriptionItems)
      .where(
        and(
          eq(subscriptionItems.subscriptionId, sub.id),
          eq(subscriptionItems.itemType, 'BASE_PLAN'),
        ),
      )
      .limit(1);
    this.logger.log(
      `[DEBUG] Step 7: existingBaseItem.length=${existingBaseItem.length}, newStripeSubscriptionItemId=${newStripeSubscriptionItemId}`,
    );

    if (existingBaseItem.length > 0) {
      // Update existing subscription item
      const updateItemData: any = {
        stripePriceId: targetPriceId || '',
        unitPriceCents: target.basePriceCents,
        updatedAt: new Date(),
      };
      // If we created a new Stripe subscription item, update it
      if (newStripeSubscriptionItemId) {
        updateItemData.stripeSubscriptionItemId = newStripeSubscriptionItemId;
      }
      this.logger.log(
        `[DEBUG] Step 7: Updating existing item with ${JSON.stringify(updateItemData)}`,
      );
      await db
        .update(subscriptionItems)
        .set(updateItemData)
        .where(eq(subscriptionItems.id, existingBaseItem[0].id));
    } else if (newStripeSubscriptionItemId) {
      // Create new subscription item (for FREE to paid upgrade)
      this.logger.log(`[DEBUG] Step 7: Creating new subscription item`);
      await db.insert(subscriptionItems).values({
        subscriptionId: sub.id,
        stripeSubscriptionItemId: newStripeSubscriptionItemId,
        itemType: 'BASE_PLAN',
        stripePriceId: targetPriceId || '',
        quantity: 1,
        unitPriceCents: target.basePriceCents,
      } as NewSubscriptionItem);
    }
    this.logger.log(`[DEBUG] Step 7 DONE`);

    // 8. Update workspace usage limits
    this.logger.log(`[DEBUG] Step 8: Updating workspace usage limits...`);
    await db
      .update(workspaceUsage)
      .set({
        channelsLimit: target.channelsPerWorkspace,
        membersLimit: target.membersPerWorkspace,
        updatedAt: new Date(),
      })
      .where(eq(workspaceUsage.workspaceId, workspaceId));
    this.logger.log(`[DEBUG] Step 8 DONE`);

    // 9. Log the change
    this.logger.log(`[DEBUG] Step 9: Logging subscription change...`);
    await db.insert(subscriptionChanges).values({
      subscriptionId: sub.id,
      changeType: preview.isUpgrade ? 'PLAN_UPGRADED' : 'PLAN_DOWNGRADED',
      oldValue: { planCode: oldPlanCode },
      newValue: { planCode: newPlanCode },
      prorationAmountCents: preview.proratedAmountCents,
      changedByUserId: userId,
      reason: `${preview.isUpgrade ? 'Upgraded' : 'Downgraded'} from ${preview.currentPlan.name} to ${preview.newPlan.name}`,
    } as NewSubscriptionChange);
    this.logger.log(`[DEBUG] Step 9 DONE - changePlan COMPLETE`);

    this.logger.log(
      `Plan changed for workspace ${workspaceId}: ${oldPlanCode} -> ${newPlanCode}`,
    );

    // 10. Send notification to user about plan change
    try {
      await this.notificationEmitter.planChanged(
        userId,
        preview.currentPlan.name,
        preview.newPlan.name,
      );
      this.logger.log(`Notification sent to user ${userId} about plan change`);
    } catch (error) {
      this.logger.error(
        `Failed to send plan change notification: ${error.message}`,
      );
      // Don't fail the plan change if notification fails
    }

    return {
      success: true,
      subscriptionId: sub.id,
      oldPlan: oldPlanCode,
      newPlan: newPlanCode,
      isUpgrade: preview.isUpgrade,
      proratedAmountCents: preview.proratedAmountCents,
      newLimits: preview.newLimits,
    };
  }

  // Get all plans (without workspace context)
  async getAllPlans(): Promise<any[]> {
    const allPlans = await db
      .select()
      .from(plans)
      .where(eq(plans.isActive, true));

    return allPlans.map((plan) => ({
      code: plan.code,
      name: plan.name,
      priceCents: plan.basePriceCents,
      priceFormatted: `$${(plan.basePriceCents / 100).toFixed(2)}/month`,
      channelsPerWorkspace: plan.channelsPerWorkspace,
      membersPerWorkspace: plan.membersPerWorkspace,
      maxWorkspaces: plan.maxWorkspaces,
      features: plan.features,
    }));
  }

  // Get available plans for upgrade/downgrade (with workspace context)
  async getAvailablePlans(workspaceId: string): Promise<any[]> {
    // Get current subscription
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

    const currentPlanCode =
      subscription.length > 0 ? subscription[0].planCode : null;

    // Get all active plans
    const allPlans = await db
      .select()
      .from(plans)
      .where(eq(plans.isActive, true));

    // Get current usage for downgrade validation
    let usage: { channelsCount: number; membersCount: number } | null = null;
    if (subscription.length > 0) {
      try {
        usage = await this.usageService.getWorkspaceUsage(workspaceId);
      } catch {
        // No usage record yet
      }
    }

    return allPlans.map((plan) => {
      const isCurrent = plan.code === currentPlanCode;
      const isUpgrade = currentPlanCode
        ? this.planHierarchy[plan.code] > this.planHierarchy[currentPlanCode]
        : false;
      const isDowngrade = currentPlanCode
        ? this.planHierarchy[plan.code] < this.planHierarchy[currentPlanCode]
        : false;

      // Check if downgrade is possible
      let canDowngrade = true;
      const downgradeIssues: string[] = [];

      if (isDowngrade && usage) {
        if (usage.channelsCount > plan.channelsPerWorkspace) {
          canDowngrade = false;
          downgradeIssues.push(
            `You have ${usage.channelsCount} channels but this plan only allows ${plan.channelsPerWorkspace}`,
          );
        }
        if (usage.membersCount > plan.membersPerWorkspace) {
          canDowngrade = false;
          downgradeIssues.push(
            `You have ${usage.membersCount} members but this plan only allows ${plan.membersPerWorkspace}`,
          );
        }
      }

      return {
        code: plan.code,
        name: plan.name,
        priceCents: plan.basePriceCents,
        priceFormatted: `$${(plan.basePriceCents / 100).toFixed(2)}/month`,
        channelsPerWorkspace: plan.channelsPerWorkspace,
        membersPerWorkspace: plan.membersPerWorkspace,
        maxWorkspaces: plan.maxWorkspaces,
        features: plan.features,
        isCurrent,
        isUpgrade,
        isDowngrade,
        canSwitch: isCurrent ? false : isUpgrade || canDowngrade,
        downgradeIssues: isDowngrade ? downgradeIssues : [],
      };
    });
  }

  // Cancel to free plan (special case)
  async downgradeToFree(
    workspaceId: string,
    userId: string,
  ): Promise<PlanChangeResult> {
    // Verify ownership
    const ws = await db
      .select()
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1);

    if (ws.length === 0) {
      throw new NotFoundException('Workspace not found');
    }

    if (ws[0].ownerId !== userId) {
      throw new ForbiddenException('Only workspace owner can change plans');
    }

    // Get current subscription
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

    if (sub.planCode === 'FREE') {
      throw new BadRequestException('Already on FREE plan');
    }

    // Validate usage
    const downgradeCheck = await this.usageService.canDowngrade(
      workspaceId,
      'FREE',
    );
    if (!downgradeCheck.canDowngrade) {
      throw new BadRequestException(
        `Cannot downgrade to FREE: ${downgradeCheck.issues.join(', ')}`,
      );
    }

    // Get FREE plan limits (used for both the scheduled and immediate paths).
    const freePlan = await db
      .select()
      .from(plans)
      .where(eq(plans.code, 'FREE'))
      .limit(1);

    const free = freePlan[0];
    const freeLimits = {
      channelsPerWorkspace: free.channelsPerWorkspace,
      membersPerWorkspace: free.membersPerWorkspace,
      maxWorkspaces: free.maxWorkspaces,
    };

    // No Stripe subscription means nothing is being billed — flip to FREE now.
    if (!sub.stripeSubscriptionId) {
      await db
        .update(subscriptions)
        .set({
          planCode: 'FREE',
          status: 'active',
          cancelAtPeriodEnd: false,
          scheduledPlanCode: null,
          scheduledChangeAt: null,
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.id, sub.id));

      await db
        .update(workspaceUsage)
        .set({
          channelsLimit: free.channelsPerWorkspace,
          membersLimit: free.membersPerWorkspace,
          extraChannelsPurchased: 0,
          extraMembersPurchased: 0,
          updatedAt: new Date(),
        })
        .where(eq(workspaceUsage.workspaceId, workspaceId));

      await db
        .delete(subscriptionItems)
        .where(eq(subscriptionItems.subscriptionId, sub.id));

      await db.insert(subscriptionChanges).values({
        subscriptionId: sub.id,
        changeType: 'PLAN_DOWNGRADED',
        oldValue: { planCode: sub.planCode },
        newValue: { planCode: 'FREE' },
        changedByUserId: userId,
        reason: 'Downgraded to FREE plan',
      } as NewSubscriptionChange);

      this.logger.log(`Workspace ${workspaceId} downgraded to FREE plan`);

      return {
        success: true,
        subscriptionId: sub.id,
        oldPlan: sub.planCode,
        newPlan: 'FREE',
        isUpgrade: false,
        proratedAmountCents: 0,
        newLimits: freeLimits,
      };
    }

    // Has a paid Stripe subscription: cancel at period end. The customer keeps
    // their paid plan until the period they already paid for ends, then Stripe
    // fires `customer.subscription.deleted` and the webhook resets us to FREE.
    await this.stripeService.cancelSubscription(sub.stripeSubscriptionId, true);

    await db
      .update(subscriptions)
      .set({
        cancelAtPeriodEnd: true,
        scheduledPlanCode: 'FREE',
        scheduledChangeAt: sub.currentPeriodEnd,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, sub.id));

    await db.insert(subscriptionChanges).values({
      subscriptionId: sub.id,
      changeType: 'PLAN_DOWNGRADED',
      oldValue: { planCode: sub.planCode },
      newValue: { planCode: 'FREE' },
      changedByUserId: userId,
      reason: 'Scheduled downgrade to FREE at period end',
    } as NewSubscriptionChange);

    this.logger.log(
      `Workspace ${workspaceId} scheduled downgrade to FREE at ${sub.currentPeriodEnd?.toISOString() ?? 'period end'}`,
    );

    return {
      success: true,
      subscriptionId: sub.id,
      oldPlan: sub.planCode,
      newPlan: 'FREE',
      isUpgrade: false,
      proratedAmountCents: 0,
      newLimits: freeLimits,
    };
  }

  /**
   * Schedule a paid → paid downgrade for the end of the current billing period.
   *
   * Swaps the Stripe price now with `proration_behavior: 'none'` — the current
   * period stays paid at the old price, and the next invoice bills the lower
   * price — but leaves our plan/limits untouched. The pending change is recorded
   * on the subscription row; `WebhookService.handleSubscriptionUpdated` flips the
   * plan + limits when the period rolls over.
   */
  private async scheduleDowngrade(
    sub: typeof subscriptions.$inferSelect,
    userId: string,
    target: typeof plans.$inferSelect,
    targetPriceId: string,
    oldPlanCode: string,
    preview: PlanChangePreview,
  ): Promise<PlanChangeResult> {
    // Swap the Stripe price now (no proration). Harmless mid-period because the
    // current period was already invoiced at the old price.
    const baseItem = await db
      .select()
      .from(subscriptionItems)
      .where(
        and(
          eq(subscriptionItems.subscriptionId, sub.id),
          eq(subscriptionItems.itemType, 'BASE_PLAN'),
        ),
      )
      .limit(1);

    if (baseItem.length > 0 && baseItem[0].stripeSubscriptionItemId) {
      const stripeSubscription = await this.stripeService.getSubscription(
        sub.stripeSubscriptionId as string,
      );
      const stripeItem: any = stripeSubscription.items.data.find(
        (item: any) => item.id === baseItem[0].stripeSubscriptionItemId,
      );
      if (stripeItem) {
        await this.stripeService.updateSubscription(
          sub.stripeSubscriptionId as string,
          {
            items: [{ id: stripeItem.id, price: targetPriceId }],
            proration_behavior: 'none',
          },
        );
      }
    }

    // Record the pending downgrade — plan/limits stay as-is until period end.
    await db
      .update(subscriptions)
      .set({
        scheduledPlanCode: target.code,
        scheduledChangeAt: sub.currentPeriodEnd,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, sub.id));

    await db.insert(subscriptionChanges).values({
      subscriptionId: sub.id,
      changeType: 'PLAN_DOWNGRADED',
      oldValue: { planCode: oldPlanCode },
      newValue: { planCode: target.code },
      prorationAmountCents: 0,
      changedByUserId: userId,
      reason: `Scheduled downgrade from ${preview.currentPlan.name} to ${preview.newPlan.name} at period end`,
    } as NewSubscriptionChange);

    this.logger.log(
      `Scheduled downgrade for workspace ${sub.workspaceId}: ${oldPlanCode} -> ${target.code} at ${sub.currentPeriodEnd?.toISOString() ?? 'period end'}`,
    );

    try {
      await this.notificationEmitter.planChanged(
        userId,
        preview.currentPlan.name,
        preview.newPlan.name,
      );
    } catch (error: any) {
      this.logger.error(
        `Failed to send plan change notification: ${error.message}`,
      );
    }

    return {
      success: true,
      subscriptionId: sub.id,
      oldPlan: oldPlanCode,
      newPlan: target.code,
      isUpgrade: false,
      proratedAmountCents: 0,
      newLimits: {
        channelsPerWorkspace: target.channelsPerWorkspace,
        membersPerWorkspace: target.membersPerWorkspace,
        maxWorkspaces: target.maxWorkspaces,
      },
    };
  }

  /**
   * Creates and pays an invoice immediately for any pending proration charges
   * Industry standard approach for immediate billing of plan upgrades
   */
  private async invoiceImmediately(
    stripeSubscriptionId: string,
  ): Promise<void> {
    try {
      const stripe = this.stripeService.getClient();

      // Get the subscription to find the customer ID and payment method
      const subscription = await stripe.subscriptions.retrieve(
        stripeSubscriptionId,
        {
          expand: ['default_payment_method'],
        },
      );
      const customerId =
        typeof subscription.customer === 'string'
          ? subscription.customer
          : subscription.customer.id;

      // Get the payment method from subscription
      const paymentMethodId =
        typeof subscription.default_payment_method === 'string'
          ? subscription.default_payment_method
          : subscription.default_payment_method?.id;

      // Create an invoice for any pending invoice items (prorations)
      const invoice = await stripe.invoices.create({
        customer: customerId,
        subscription: stripeSubscriptionId,
        auto_advance: true,
      });

      // If there are charges, pay the invoice immediately
      if (invoice.amount_due > 0) {
        // Use the subscription's payment method if available
        const payParams: Stripe.InvoicePayParams = {};
        if (paymentMethodId) {
          payParams.payment_method = paymentMethodId;
        }
        await stripe.invoices.pay(invoice.id, payParams);
        this.logger.log(
          `Immediately charged ${invoice.amount_due} cents for plan upgrade`,
        );
      } else if (invoice.status === 'draft') {
        // Finalize even if $0 (for record keeping)
        await stripe.invoices.finalizeInvoice(invoice.id);
      }
    } catch (error: any) {
      // If no pending items to invoice, that's okay
      if (error.code === 'invoice_no_subscription_line_items') {
        return;
      }
      this.logger.error(`Failed to create immediate invoice: ${error.message}`);
      throw error;
    }
  }
}
