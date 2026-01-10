import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import Stripe from 'stripe';
import { StripeService } from '../../stripe/stripe.service';
import { CustomerService } from './customer.service';
import { db } from '../../drizzle/db';
import {
  subscriptions,
  subscriptionItems,
  workspaceUsage,
  plans,
  workspace,
  NewSubscription,
  NewSubscriptionItem,
  NewWorkspaceUsage,
} from '../../drizzle/schema';

export interface CreateSubscriptionDto {
  workspaceId: string;
  userId: string;
  planCode: string;
  paymentMethodId?: string;
  trialPeriodDays?: number;
}

export interface SubscriptionResponse {
  subscriptionId: number;
  stripeSubscriptionId: string;
  planCode: string;
  status: string;
  currentPeriodEnd: Date | null;
  clientSecret?: string;
  limits: {
    channels: number;
    members: number;
    workspaces: number;
  };
}

@Injectable()
export class SubscriptionService {
  constructor(
    private stripeService: StripeService,
    private customerService: CustomerService,
  ) {}

  async createSubscription(
    dto: CreateSubscriptionDto,
  ): Promise<SubscriptionResponse> {
    // 1. Get or create Stripe customer
    const { stripeCustomerId } =
      await this.customerService.getOrCreateStripeCustomer(dto.userId);

    // 2. Validate workspace exists and user is owner
    const ws = await db
      .select()
      .from(workspace)
      .where(
        and(
          eq(workspace.id, dto.workspaceId),
          eq(workspace.ownerId, dto.userId),
        ),
      )
      .limit(1);

    if (ws.length === 0) {
      throw new NotFoundException(
        'Workspace not found or you are not the owner',
      );
    }

    // 3. Check if workspace already has a subscription
    const existingSub = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.workspaceId, dto.workspaceId))
      .limit(1);

    if (existingSub.length > 0) {
      throw new BadRequestException('Workspace already has a subscription');
    }

    // 4. Get plan details
    const plan = await db
      .select()
      .from(plans)
      .where(eq(plans.code, dto.planCode))
      .limit(1);

    if (plan.length === 0) {
      throw new NotFoundException('Plan not found');
    }

    const selectedPlan = plan[0];

    // 5. Handle FREE plan (no Stripe subscription needed)
    if (dto.planCode === 'FREE') {
      return await this.createFreeSubscription(
        dto.workspaceId,
        stripeCustomerId,
        selectedPlan,
      );
    }

    // 6. Attach payment method if provided
    if (dto.paymentMethodId) {
      await this.stripeService.attachPaymentMethod(
        dto.paymentMethodId,
        stripeCustomerId,
      );
      await this.stripeService.setDefaultPaymentMethod(
        stripeCustomerId,
        dto.paymentMethodId,
      );
    }

    // 7. Create Stripe subscription
    if (!selectedPlan.stripePriceId) {
      throw new BadRequestException(
        'Plan does not have a Stripe price ID configured',
      );
    }

    const stripeSubscription = await this.stripeService.createSubscription({
      customerId: stripeCustomerId,
      priceId: selectedPlan.stripePriceId,
      metadata: {
        workspaceId: dto.workspaceId,
        userId: dto.userId,
        planCode: dto.planCode,
      },
      trialPeriodDays: dto.trialPeriodDays,
    });

    // 8. Save subscription to database
    const sub: any = stripeSubscription;
    const [newSubscription] = await db
      .insert(subscriptions)
      .values({
        workspaceId: dto.workspaceId,
        stripeCustomerId,
        stripeSubscriptionId: stripeSubscription.id,
        planCode: dto.planCode,
        status: stripeSubscription.status,
        currentPeriodStart: new Date(sub.current_period_start * 1000),
        currentPeriodEnd: new Date(sub.current_period_end * 1000),
        trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
      } as NewSubscription)
      .returning();

    // 9. Create subscription item for base plan
    await db.insert(subscriptionItems).values({
      subscriptionId: newSubscription.id,
      stripeSubscriptionItemId: stripeSubscription.items.data[0].id,
      itemType: 'BASE_PLAN',
      stripePriceId: selectedPlan.stripePriceId,
      quantity: 1,
      unitPriceCents: selectedPlan.basePriceCents,
    } as NewSubscriptionItem);

    // 10. Initialize workspace usage
    await db.insert(workspaceUsage).values({
      workspaceId: dto.workspaceId,
      channelsCount: 0,
      channelsLimit: selectedPlan.channelsPerWorkspace,
      extraChannelsPurchased: 0,
      membersCount: 0,
      membersLimit: selectedPlan.membersPerWorkspace,
      extraMembersPurchased: 0,
    } as NewWorkspaceUsage);

    // 11. Extract client secret for frontend
    const latestInvoice: any = sub.latest_invoice;
    const clientSecret = latestInvoice?.payment_intent?.client_secret;

    return {
      subscriptionId: newSubscription.id,
      stripeSubscriptionId: stripeSubscription.id,
      planCode: dto.planCode,
      status: stripeSubscription.status,
      currentPeriodEnd: newSubscription.currentPeriodEnd,
      clientSecret: clientSecret || undefined,
      limits: {
        channels: selectedPlan.channelsPerWorkspace,
        members: selectedPlan.membersPerWorkspace,
        workspaces: selectedPlan.maxWorkspaces,
      },
    };
  }

  private async createFreeSubscription(
    workspaceId: string,
    stripeCustomerId: string,
    plan: typeof plans.$inferSelect,
  ): Promise<SubscriptionResponse> {
    // Create local subscription record without Stripe subscription
    const [newSubscription] = await db
      .insert(subscriptions)
      .values({
        workspaceId,
        stripeCustomerId,
        stripeSubscriptionId: null,
        planCode: 'FREE',
        status: 'active',
        currentPeriodStart: new Date(),
        currentPeriodEnd: null,
        trialEnd: null,
      } as NewSubscription)
      .returning();

    // Initialize workspace usage
    await db.insert(workspaceUsage).values({
      workspaceId,
      channelsCount: 0,
      channelsLimit: plan.channelsPerWorkspace,
      extraChannelsPurchased: 0,
      membersCount: 0,
      membersLimit: plan.membersPerWorkspace,
      extraMembersPurchased: 0,
    } as NewWorkspaceUsage);

    return {
      subscriptionId: newSubscription.id,
      stripeSubscriptionId: 'free-plan',
      planCode: 'FREE',
      status: 'active',
      currentPeriodEnd: null,
      limits: {
        channels: plan.channelsPerWorkspace,
        members: plan.membersPerWorkspace,
        workspaces: plan.maxWorkspaces,
      },
    };
  }

  async getSubscriptionByWorkspaceId(workspaceId: string) {
    const subscription = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.workspaceId, workspaceId))
      .limit(1);

    if (subscription.length === 0) {
      throw new NotFoundException('Subscription not found for this workspace');
    }

    return subscription[0];
  }

  async cancelSubscription(
    workspaceId: string,
    userId: string,
    cancelAtPeriodEnd: boolean = true,
  ): Promise<{ message: string }> {
    // Get subscription
    const subscription = await this.getSubscriptionByWorkspaceId(workspaceId);

    // Verify ownership
    const ws = await db
      .select()
      .from(workspace)
      .where(
        and(eq(workspace.id, workspaceId), eq(workspace.ownerId, userId)),
      )
      .limit(1);

    if (ws.length === 0) {
      throw new NotFoundException('Workspace not found or you are not the owner');
    }

    // Handle FREE plan
    if (subscription.planCode === 'FREE') {
      throw new BadRequestException('Cannot cancel free plan');
    }

    // Cancel in Stripe
    if (subscription.stripeSubscriptionId) {
      await this.stripeService.cancelSubscription(
        subscription.stripeSubscriptionId,
        cancelAtPeriodEnd,
      );
    }

    // Update database
    if (cancelAtPeriodEnd) {
      await db
        .update(subscriptions)
        .set({
          cancelAtPeriodEnd: true,
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.id, subscription.id));

      return {
        message: `Subscription will be canceled at the end of the billing period (${subscription.currentPeriodEnd})`,
      };
    } else {
      await db
        .update(subscriptions)
        .set({
          status: 'canceled',
          canceledAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.id, subscription.id));

      return {
        message: 'Subscription canceled immediately',
      };
    }
  }
}
