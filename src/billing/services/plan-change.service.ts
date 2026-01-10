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
  plans,
  workspaceUsage,
  subscriptionChanges,
  workspace,
  NewSubscriptionChange,
} from '../../drizzle/schema';
import { StripeService } from '../../stripe/stripe.service';
import { UsageService } from './usage.service';

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

  // Plan hierarchy for determining upgrade vs downgrade
  private readonly planHierarchy: Record<string, number> = {
    FREE: 0,
    PRO: 1,
    MAX: 2,
  };

  constructor(
    private stripeService: StripeService,
    private usageService: UsageService,
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
          Math.ceil((periodEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
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
    // 1. Preview to validate
    const preview = await this.previewPlanChange(workspaceId, userId, newPlanCode);

    if (!preview.canChange && !options?.forceDowngrade) {
      throw new BadRequestException(
        `Cannot change plan: ${preview.validationIssues.join(', ')}`,
      );
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

    const sub = subscription[0];
    const oldPlanCode = sub.planCode;

    // 3. Get new plan
    const newPlan = await db
      .select()
      .from(plans)
      .where(eq(plans.code, newPlanCode))
      .limit(1);

    const target = newPlan[0];

    // 4. Handle Stripe subscription update
    if (sub.stripeSubscriptionId && target.stripePriceId) {
      // Get current base plan subscription item
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
          await this.stripeService.updateSubscription(sub.stripeSubscriptionId, {
            items: [
              {
                id: stripeItem.id,
                price: target.stripePriceId,
              },
            ],
            proration_behavior: preview.isUpgrade ? 'create_prorations' : 'none',
          });
        }
      } else {
        // No existing item, add new one
        await this.stripeService.addSubscriptionItem({
          subscriptionId: sub.stripeSubscriptionId,
          priceId: target.stripePriceId,
          quantity: 1,
        });
      }
    }

    // 5. Update subscription in database
    await db
      .update(subscriptions)
      .set({
        planCode: newPlanCode,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, sub.id));

    // 6. Update base plan subscription item
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

    if (existingBaseItem.length > 0) {
      await db
        .update(subscriptionItems)
        .set({
          stripePriceId: target.stripePriceId || '',
          unitPriceCents: target.basePriceCents,
          updatedAt: new Date(),
        })
        .where(eq(subscriptionItems.id, existingBaseItem[0].id));
    }

    // 7. Update workspace usage limits
    await db
      .update(workspaceUsage)
      .set({
        channelsLimit: target.channelsPerWorkspace,
        membersLimit: target.membersPerWorkspace,
        updatedAt: new Date(),
      })
      .where(eq(workspaceUsage.workspaceId, workspaceId));

    // 8. Log the change
    await db.insert(subscriptionChanges).values({
      subscriptionId: sub.id,
      changeType: preview.isUpgrade ? 'PLAN_UPGRADED' : 'PLAN_DOWNGRADED',
      oldValue: { planCode: oldPlanCode },
      newValue: { planCode: newPlanCode },
      prorationAmountCents: preview.proratedAmountCents,
      changedByUserId: userId,
      reason: `${preview.isUpgrade ? 'Upgraded' : 'Downgraded'} from ${preview.currentPlan.name} to ${preview.newPlan.name}`,
    } as NewSubscriptionChange);

    this.logger.log(
      `Plan changed for workspace ${workspaceId}: ${oldPlanCode} -> ${newPlanCode}`,
    );

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

  // Get available plans for upgrade/downgrade
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

    const currentPlanCode = subscription.length > 0 ? subscription[0].planCode : null;

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
    const downgradeCheck = await this.usageService.canDowngrade(workspaceId, 'FREE');
    if (!downgradeCheck.canDowngrade) {
      throw new BadRequestException(
        `Cannot downgrade to FREE: ${downgradeCheck.issues.join(', ')}`,
      );
    }

    // Cancel Stripe subscription if exists
    if (sub.stripeSubscriptionId) {
      await this.stripeService.cancelSubscription(sub.stripeSubscriptionId, false);
    }

    // Get FREE plan limits
    const freePlan = await db
      .select()
      .from(plans)
      .where(eq(plans.code, 'FREE'))
      .limit(1);

    const free = freePlan[0];

    // Update subscription to FREE
    await db
      .update(subscriptions)
      .set({
        planCode: 'FREE',
        stripeSubscriptionId: null,
        status: 'active',
        cancelAtPeriodEnd: false,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, sub.id));

    // Update usage limits
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

    // Remove all add-on subscription items
    await db
      .delete(subscriptionItems)
      .where(eq(subscriptionItems.subscriptionId, sub.id));

    // Log change
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
      newLimits: {
        channelsPerWorkspace: free.channelsPerWorkspace,
        membersPerWorkspace: free.membersPerWorkspace,
        maxWorkspaces: free.maxWorkspaces,
      },
    };
  }
}
