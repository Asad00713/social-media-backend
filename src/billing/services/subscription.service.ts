import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { eq, and, sql } from 'drizzle-orm';
import Stripe from 'stripe';
import { buildSubscriptionSync } from './subscription-sync.util';
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

    // 7. Read the provisioned Stripe price for the plan (read-only — prices are
    //    provisioned out-of-band by the stripe-provision script; FREE returned
    //    above at step 5, so only paid plans reach here).
    const stripePriceId = selectedPlan.stripePriceId;

    if (!stripePriceId) {
      throw new BadRequestException(
        `Plan "${selectedPlan.code}" is not provisioned in Stripe — run the pricing provision script (npx ts-node src/drizzle/seeds/stripe-provision.ts)`,
      );
    }

    // 8. Create Stripe subscription
    const stripeSubscription = await this.stripeService.createSubscription({
      customerId: stripeCustomerId,
      priceId: stripePriceId,
      metadata: {
        workspaceId: dto.workspaceId,
        userId: dto.userId,
        planCode: dto.planCode,
      },
      trialPeriodDays: dto.trialPeriodDays,
    });

    // 8. Save subscription to database
    const sub: any = stripeSubscription;
    const subscriptionData: any = {
      workspaceId: dto.workspaceId,
      stripeCustomerId,
      stripeSubscriptionId: stripeSubscription.id,
      planCode: dto.planCode,
      status: stripeSubscription.status,
      currentPeriodStart: new Date(sub.current_period_start * 1000),
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
    };
    // Only add trialEnd if it exists (avoid explicit null for timestamps)
    if (sub.trial_end) {
      subscriptionData.trialEnd = new Date(sub.trial_end * 1000);
    }
    const [newSubscription] = await db
      .insert(subscriptions)
      .values(subscriptionData as NewSubscription)
      .returning();

    // 9. Create subscription item for base plan
    await db.insert(subscriptionItems).values({
      subscriptionId: newSubscription.id,
      stripeSubscriptionItemId: stripeSubscription.items.data[0].id,
      itemType: 'BASE_PLAN',
      stripePriceId: stripePriceId,
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
    // Note: Omit null timestamp fields instead of explicitly setting them to avoid Drizzle timestamp issues
    const [newSubscription] = await db
      .insert(subscriptions)
      .values({
        workspaceId,
        stripeCustomerId,
        planCode: 'FREE',
        status: 'active',
        currentPeriodStart: new Date(),
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

  /**
   * Hard-reset the workspace's billing state back to FREE without touching
   * Stripe. Use when stripeSubscriptionId in DB points at a subscription
   * that no longer exists on Stripe (test data wipe, account swap, mode
   * mismatch). After reset the user can re-subscribe through the normal
   * flow — which on a clean slate forces them to add a card first.
   */
  async resetBillingState(
    workspaceId: string,
    userId: string,
  ): Promise<{ success: true; message: string }> {
    const ws = await db
      .select()
      .from(workspace)
      .where(and(eq(workspace.id, workspaceId), eq(workspace.ownerId, userId)))
      .limit(1);

    if (ws.length === 0) {
      throw new NotFoundException(
        'Workspace not found or you are not the owner',
      );
    }

    // Wipe subscription items first (FK to subscriptions)
    const sub = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(eq(subscriptions.workspaceId, workspaceId))
      .limit(1);

    if (sub.length > 0) {
      await db
        .delete(subscriptionItems)
        .where(eq(subscriptionItems.subscriptionId, sub[0].id));

      // Reset subscription row to FREE / clean state
      await db
        .update(subscriptions)
        .set({
          planCode: 'FREE',
          status: 'active',
          stripeSubscriptionId: null,
          currentPeriodStart: new Date(),
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.id, sub[0].id));
    }

    return {
      success: true,
      message:
        'Billing state reset. You are now on the Free plan — pick a paid plan and add a payment method to upgrade.',
    };
  }

  async createCheckoutSession(dto: {
    workspaceId: string;
    userId: string;
    planCode: string;
  }): Promise<{ url: string }> {
    // 1. Validate workspace exists and user is owner (mirror createSubscription).
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

    // 2. Resolve the plan and ensure it is paid + provisioned.
    const planRows = await db
      .select()
      .from(plans)
      .where(eq(plans.code, dto.planCode))
      .limit(1);
    const plan = planRows[0];
    if (!plan) throw new NotFoundException('Plan not found');
    if (plan.basePriceCents <= 0) {
      throw new BadRequestException('FREE plan does not require checkout');
    }
    if (!plan.stripePriceId) {
      throw new BadRequestException(
        `Plan "${plan.code}" is not provisioned in Stripe — run the pricing provision script`,
      );
    }

    // 3. Stripe customer + redirect URLs.
    const { stripeCustomerId } =
      await this.customerService.getOrCreateStripeCustomer(dto.userId);
    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3001';
    const base = `${frontendUrl}/dashboard/${dto.workspaceId}/settings/plans`;

    const session = await this.stripeService.createCheckoutSession({
      customerId: stripeCustomerId,
      priceId: plan.stripePriceId,
      successUrl: `${base}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}?checkout=cancelled`,
      metadata: {
        workspaceId: dto.workspaceId,
        userId: dto.userId,
        planCode: dto.planCode,
      },
    });

    if (!session.url) {
      throw new BadRequestException('Failed to create checkout session');
    }
    return { url: session.url };
  }

  /**
   * Idempotently persist a Stripe subscription into our DB (subscriptions +
   * BASE_PLAN item + workspace_usage). Used by the checkout webhook and any
   * direct path. Upserts on the workspace's existing row (FREE→paid updates the
   * pre-existing FREE row rather than inserting a duplicate).
   */
  async persistStripeSubscription(input: {
    workspaceId: string;
    planCode: string;
    stripeCustomerId: string;
    stripeSubscription: Stripe.Subscription;
  }): Promise<void> {
    const planRows = await db
      .select()
      .from(plans)
      .where(eq(plans.code, input.planCode))
      .limit(1);
    const plan = planRows[0];
    if (!plan) {
      throw new NotFoundException(`Plan "${input.planCode}" not found`);
    }

    const { subscriptionRow, baseItem, usageRow } = buildSubscriptionSync({
      workspaceId: input.workspaceId,
      planCode: input.planCode,
      plan,
      stripeCustomerId: input.stripeCustomerId,
      stripeSubscription: input.stripeSubscription,
    });

    // 1. Upsert the subscriptions row (UNIQUE workspace_id → updates FREE row).
    const subSet: Record<string, unknown> = {
      stripeCustomerId: sql`excluded.stripe_customer_id`,
      stripeSubscriptionId: sql`excluded.stripe_subscription_id`,
      planCode: sql`excluded.plan_code`,
      status: sql`excluded.status`,
      currentPeriodStart: sql`excluded.current_period_start`,
      currentPeriodEnd: sql`excluded.current_period_end`,
      cancelAtPeriodEnd: sql`excluded.cancel_at_period_end`,
      updatedAt: new Date(),
    };
    if ('trialEnd' in subscriptionRow) {
      subSet.trialEnd = sql`excluded.trial_end`;
    }
    await db
      .insert(subscriptions)
      .values(subscriptionRow as NewSubscription)
      .onConflictDoUpdate({ target: subscriptions.workspaceId, set: subSet });

    // 2. Get the subscription id for the item upsert.
    const savedRows = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(eq(subscriptions.workspaceId, input.workspaceId))
      .limit(1);
    const subscriptionId = savedRows[0].id;

    // 3. Upsert the BASE_PLAN item (UNIQUE subscription_id + item_type).
    await db
      .insert(subscriptionItems)
      .values({ ...baseItem, subscriptionId } as NewSubscriptionItem)
      .onConflictDoUpdate({
        target: [subscriptionItems.subscriptionId, subscriptionItems.itemType],
        set: {
          stripeSubscriptionItemId: sql`excluded.stripe_subscription_item_id`,
          stripePriceId: sql`excluded.stripe_price_id`,
          quantity: sql`excluded.quantity`,
          unitPriceCents: sql`excluded.unit_price_cents`,
          updatedAt: new Date(),
        },
      });

    // 4. Upsert workspace_usage limits (UNIQUE workspace_id).
    await db
      .insert(workspaceUsage)
      .values(usageRow as NewWorkspaceUsage)
      .onConflictDoUpdate({
        target: workspaceUsage.workspaceId,
        set: {
          channelsLimit: sql`excluded.channels_limit`,
          membersLimit: sql`excluded.members_limit`,
          aiTokensLimit: sql`excluded.ai_tokens_limit`,
          updatedAt: new Date(),
        },
      });
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
      .where(and(eq(workspace.id, workspaceId), eq(workspace.ownerId, userId)))
      .limit(1);

    if (ws.length === 0) {
      throw new NotFoundException(
        'Workspace not found or you are not the owner',
      );
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
