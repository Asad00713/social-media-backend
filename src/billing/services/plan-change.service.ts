import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import {
  subscriptions,
  subscriptionItems,
  plans,
  workspaceUsage,
  subscriptionChanges,
  workspace,
  providerSubscriptions,
  ProviderSubscription,
  NewSubscriptionChange,
  NewSubscriptionItem,
} from '../../drizzle/schema';
import { StripeService } from '../../stripe/stripe.service';
import { UsageService } from './usage.service';
import { SubscriptionLookupService } from './subscription-lookup.service';
import { hasLiveBasePlan } from './provider-subscription.util';
import { ProviderRegistryService } from '../providers/provider-registry.service';
import { createStripeSubscriptionDirect } from '../providers/stripe-direct-subscribe.util';
import { clearStaleStripeSubscription } from '../providers/stripe-stale-subscription.util';
import { invoiceStripeProrationsImmediately } from '../providers/stripe-immediate-invoice.util';
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
    private readonly lookup: SubscriptionLookupService,
    private notificationEmitter: NotificationEmitterService,
    private readonly providers: ProviderRegistryService,
  ) {}

  /**
   * Every provider record for one of our subscriptions.
   *
   * The provider-neutral answer to "what is this account actually paying for",
   * replacing the `sub.stripeSubscriptionId` reads that silently mis-branched
   * every Lemon Squeezy account.
   */
  private async providerRowsFor(
    subscriptionId: number,
  ): Promise<ProviderSubscription[]> {
    const rows = await db
      .select()
      .from(providerSubscriptions)
      .where(eq(providerSubscriptions.subscriptionId, subscriptionId));
    return rows as ProviderSubscription[];
  }

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

    // 2. Get the account's current subscription (ownership verified above, so
    //    `userId` is the owner who pays for this workspace).
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
      // Account-scoped: a downgrade re-limits EVERY workspace the user owns,
      // so validating just this one would let a second workspace slip through
      // over the new limit.
      const downgradeCheck = await this.usageService.canDowngrade(
        userId,
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

    // 2. Get the account's subscription (previewPlanChange already verified
    //    that `userId` owns this workspace).
    this.logger.log(`[DEBUG] Step 2: Getting subscription...`);
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

    const sub = subscription[0];
    this.logger.log(
      `[DEBUG] Step 2 DONE: sub.id=${sub.id}, stripeSubId=${sub.stripeSubscriptionId}, currentPeriodEnd=${sub.currentPeriodEnd}`,
    );
    const oldPlanCode = sub.planCode;

    // Which provider bills this account decides every branch below.
    const adapter = await this.providers.adapterForSubscription(sub.id);

    // Defensive, Stripe only: the stored stripeSubscriptionId may have been
    // wiped on Stripe's side (test data reset, account switch, mode change).
    // Verify it still exists before we try to mutate it. If it is gone, null
    // it out and let the user proceed via Checkout instead of crashing.
    if (adapter.name === 'stripe') {
      const wasStale = await clearStaleStripeSubscription(
        this.stripeService,
        sub,
        `workspace ${workspaceId}`,
      );
      if (wasStale) {
        // The column is already nulled in the DB; wipe the in-memory copy so
        // the rest of changePlan takes the "no existing subscription" path
        // (Checkout flow) instead of calling Stripe with a dead id.
        sub.stripeSubscriptionId = null;
      }
    }

    // 3. Get new plan
    const newPlan = await db
      .select()
      .from(plans)
      .where(eq(plans.code, newPlanCode))
      .limit(1);

    const target = newPlan[0];

    // 4. Is the TARGET a paid plan? This is a property of the plan itself, not
    //    of any provider. It used to be inferred from `target.stripePriceId`
    //    being non-empty, which is a Stripe column - a Lemon Squeezy account
    //    moving to a plan Stripe had never provisioned took the wrong branch.
    const isTargetPaid = target.basePriceCents > 0;

    // Does the account ALREADY pay someone? Read from `provider_subscriptions`
    // (written by every provider), never from `stripeSubscriptionId` (NULL for
    // every Lemon Squeezy account, which made `changePlan` fall through to the
    // FREE-upgrade branch and throw a spurious 400 for LS paid->paid changes).
    const isAlreadyPaying = hasLiveBasePlan(await this.providerRowsFor(sub.id));

    // Stripe's price id is still needed further down for the direct
    // FREE -> paid path and for the `subscription_items` bookkeeping row, but
    // it no longer decides any branch.
    const targetPriceId = target.stripePriceId;

    if (!targetPriceId && isTargetPaid && adapter.name === 'stripe') {
      throw new BadRequestException(
        `Plan "${target.code}" is not provisioned in Stripe — run the pricing provision script (npx ts-node src/drizzle/seeds/stripe-provision.ts)`,
      );
    }

    // DOWNGRADE (paid → lower paid tier): defer to period end. The customer
    // keeps their current plan + limits until `currentPeriodEnd`; we swap the
    // Stripe price now with NO proration (so the next invoice bills the lower
    // price), and the webhook flips our plan/limits once the period rolls over.
    if (!preview.isUpgrade && isAlreadyPaying && isTargetPaid) {
      return await this.scheduleDowngrade(
        sub,
        userId,
        target,
        oldPlanCode,
        preview,
      );
    }

    // 5. Change the plan at whichever provider bills this account, or start a
    //    brand-new paid subscription if the account is coming off FREE.
    let newStripeSubscriptionId: string | null = null;
    let newStripeSubscriptionItemId: string | null = null;

    if (isAlreadyPaying && isTargetPaid) {
      // An existing paid subscription: one abstracted operation. The adapter
      // owns the provider-specific shape of it - Stripe swaps the price on the
      // BASE_PLAN line item, Lemon Squeezy PATCHes the subscription's variant.
      await adapter.changePlan(sub.id, newPlanCode);

      // Upgrades charge immediately (industry standard). This is Stripe-only
      // proration plumbing with no Lemon Squeezy equivalent - LS invoices the
      // change itself via `invoice_immediately` inside its own adapter - so it
      // is gated rather than abstracted.
      if (
        preview.isUpgrade &&
        adapter.name === 'stripe' &&
        sub.stripeSubscriptionId
      ) {
        await invoiceStripeProrationsImmediately(
          this.stripeService,
          sub.stripeSubscriptionId,
        );
      }
    } else if (!isAlreadyPaying && isTargetPaid) {
      // FREE -> paid with a card already on file. Like
      // `SubscriptionService.createSubscription`, this is a Stripe-only path:
      // it creates a subscription server-side from a stored payment method,
      // which Lemon Squeezy has no endpoint for. Refuse other providers rather
      // than silently billing them through Stripe - they go via Checkout.
      if (adapter.name !== 'stripe') {
        throw new BadRequestException(
          `Upgrading from FREE is not supported directly for ${adapter.name} - ` +
            'start a checkout session instead.',
        );
      }

      this.logger.log(
        `Creating new Stripe subscription for upgrade from FREE to ${newPlanCode}`,
      );

      // Guard: a FREE -> paid upgrade requires a Stripe customer. The Checkout
      // flow creates one before the webhook fires; a direct call on an account
      // that never reached Stripe has none. (The card check lives inside
      // `createStripeSubscriptionDirect`.)
      if (!sub.stripeCustomerId) {
        throw new BadRequestException(
          'This account has no Stripe customer yet - subscribe via Checkout',
        );
      }

      // Non-null by construction: `isTargetPaid` is true in this branch and
      // the provisioning check above throws for a Stripe account whose target
      // plan has no price. The other providers were refused a few lines up.
      if (!targetPriceId) {
        throw new BadRequestException(
          `Plan "${target.code}" is not provisioned in Stripe — run the pricing provision script (npx ts-node src/drizzle/seeds/stripe-provision.ts)`,
        );
      }

      const stripeSubscription = await createStripeSubscriptionDirect(
        this.stripeService,
        {
          stripeCustomerId: sub.stripeCustomerId,
          stripePriceId: targetPriceId,
          metadata: {
            workspaceId,
            userId,
            planCode: newPlanCode,
          },
        },
      );

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

    // 8. Update usage limits on EVERY workspace the account owns. One
    //    subscription covers all of them, so writing a single row would leave
    //    the rest on the OLD plan's limits with no error raised. The AI-token
    //    allowance moves with the plan too — without that, an upgrade or
    //    downgrade left the old limit and the Maestro meter never reflected the
    //    new plan. `aiTokensUsedThisMonth` is intentionally NOT reset (no free
    //    refill on every plan switch); the monthly reset does that.
    this.logger.log(`[DEBUG] Step 8: Updating workspace usage limits...`);
    const changeAddons = await this.lookup.getAddonQuantities(sub.id);
    await this.lookup.applyLimitsToAllWorkspaces(
      userId,
      newPlanCode,
      changeAddons,
    );
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
      aiTokensPerMonth: plan.aiTokensPerMonth,
      features: plan.features,
    }));
  }

  // Get available plans for upgrade/downgrade (with workspace context)
  async getAvailablePlans(workspaceId: string): Promise<any[]> {
    // The subscription that pays for this workspace is its owner's.
    const ownerId = await this.lookup.getOwnerId(workspaceId);

    const subscription = ownerId
      ? await db
          .select()
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.userId, ownerId),
              eq(subscriptions.status, 'active'),
            ),
          )
          .limit(1)
      : [];

    const currentPlanCode =
      subscription.length > 0 ? subscription[0].planCode : null;

    // Get all active plans
    const allPlans = await db
      .select()
      .from(plans)
      .where(eq(plans.isActive, true));

    // Usage for downgrade validation, across EVERY workspace the account owns.
    // A downgrade re-limits all of them, so a plan is only offered as
    // switchable when every workspace fits under it — otherwise the list would
    // advertise a downgrade that `changePlan` then rejects.
    const ownedUsage =
      subscription.length > 0 && ownerId
        ? await db
            .select({
              workspaceName: workspace.name,
              channelsCount: workspaceUsage.channelsCount,
              membersCount: workspaceUsage.membersCount,
            })
            .from(workspace)
            .innerJoin(
              workspaceUsage,
              eq(workspaceUsage.workspaceId, workspace.id),
            )
            .where(eq(workspace.ownerId, ownerId))
            .orderBy(workspace.createdAt, workspace.id)
        : [];

    return allPlans.map((plan) => {
      const isCurrent = plan.code === currentPlanCode;
      const isUpgrade = currentPlanCode
        ? this.planHierarchy[plan.code] > this.planHierarchy[currentPlanCode]
        : false;
      const isDowngrade = currentPlanCode
        ? this.planHierarchy[plan.code] < this.planHierarchy[currentPlanCode]
        : false;

      // Check if downgrade is possible — same rule the enforcement path uses.
      const downgradeIssues = isDowngrade
        ? ownedUsage.flatMap((ws) =>
            UsageService.describeDowngradeIssues(ws, plan),
          )
        : [];
      const canDowngrade = downgradeIssues.length === 0;

      return {
        code: plan.code,
        name: plan.name,
        priceCents: plan.basePriceCents,
        priceFormatted: `$${(plan.basePriceCents / 100).toFixed(2)}/month`,
        channelsPerWorkspace: plan.channelsPerWorkspace,
        membersPerWorkspace: plan.membersPerWorkspace,
        maxWorkspaces: plan.maxWorkspaces,
        aiTokensPerMonth: plan.aiTokensPerMonth,
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

    // Get the account's current subscription (ownership verified above).
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

    if (sub.planCode === 'FREE') {
      throw new BadRequestException('Already on FREE plan');
    }

    // Validate usage across every workspace the account owns — dropping to
    // FREE re-limits all of them at once.
    const downgradeCheck = await this.usageService.canDowngrade(userId, 'FREE');
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

    // Nothing live at ANY provider means nothing is being billed - flip to
    // FREE now. This used to ask `if (!sub.stripeSubscriptionId)`, which is
    // NULL for every Lemon Squeezy account: the branch always fired, the
    // customer was stripped to FREE limits, and the method returned without
    // ever cancelling at Lemon Squeezy - so they kept being charged,
    // indefinitely, with no error. `provider_subscriptions` is the table every
    // provider writes, so it is what this must read.
    if (!hasLiveBasePlan(await this.providerRowsFor(sub.id))) {
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

      // FREE limits land on EVERY workspace the account owns — writing one row
      // would leave the rest on the plan the user just left. Add-ons don't
      // carry over, so pass zeroes (the items are deleted just below).
      await this.lookup.applyLimitsToAllWorkspaces(userId, 'FREE', {
        extraChannels: 0,
        extraMembers: 0,
        extraWorkspaces: 0,
        extraAiTokens: 0,
      });

      await db
        .update(workspaceUsage)
        .set({
          extraChannelsPurchased: 0,
          extraMembersPurchased: 0,
          extraAiTokensPurchased: 0,
          updatedAt: new Date(),
        })
        .where(
          inArray(
            workspaceUsage.workspaceId,
            db
              .select({ id: workspace.id })
              .from(workspace)
              .where(eq(workspace.ownerId, userId)),
          ),
        );

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

    // Something IS live at the provider: cancel at period end. The customer
    // keeps their paid plan until the period they already paid for ends, then
    // the provider's webhook (Stripe's `customer.subscription.deleted`, Lemon
    // Squeezy's expiry) resets us to FREE.
    const cancelAdapter = await this.providers.adapterForSubscription(sub.id);
    await cancelAdapter.cancel(sub.id, true);

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
   * Swaps the plan at the provider now (Stripe with `proration_behavior:
   * 'none'`) — the current period stays paid at the old price, and the next
   * invoice bills the lower one — but leaves our plan/limits untouched. The
   * pending change is recorded on the subscription row; the provider's webhook
   * flips the plan + limits when the period rolls over.
   */
  private async scheduleDowngrade(
    sub: typeof subscriptions.$inferSelect,
    userId: string,
    target: typeof plans.$inferSelect,
    oldPlanCode: string,
    preview: PlanChangePreview,
  ): Promise<PlanChangeResult> {
    // Swap to the cheaper plan at the provider NOW, with no proration on
    // Stripe's side. Harmless mid-period because the current period was
    // already invoiced at the old price - the next invoice bills the lower
    // one. `changePlan` is the same abstracted operation an upgrade uses; the
    // difference between the two is our own scheduling, below, not the call.
    const adapter = await this.providers.adapterForSubscription(sub.id);
    await adapter.changePlan(sub.id, target.code);

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
      `Scheduled downgrade for user ${sub.userId}: ${oldPlanCode} -> ${target.code} at ${sub.currentPeriodEnd?.toISOString() ?? 'period end'}`,
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
}
