import { Injectable, Logger } from '@nestjs/common';
import { eq, and, gt } from 'drizzle-orm';
import Stripe from 'stripe';
import { db } from '../../drizzle/db';
import {
  billingEvents,
  subscriptions,
  subscriptionItems,
  invoices,
  failedPayments,
  workspaceUsage,
  paymentMethods,
  stripeCustomers,
  plans,
  NewBillingEvent,
  NewFailedPayment,
} from '../../drizzle/schema';
import { SubscriptionService } from './subscription.service';
import {
  getInvoiceSubscriptionId,
  upsertInvoiceFromStripe,
} from './invoice-sync.util';
import { getSubscriptionPeriod } from './subscription-sync.util';
import { StripeService } from '../../stripe/stripe.service';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  // Configuration for failed payment handling
  private readonly MAX_FAILED_ATTEMPTS = 3;
  private readonly GRACE_PERIOD_DAYS = 7;

  constructor(
    private subscriptionService: SubscriptionService,
    private stripeService: StripeService,
  ) {}

  async handleWebhook(event: Stripe.Event): Promise<void> {
    // Check if event already processed
    const existingEvent = await db
      .select()
      .from(billingEvents)
      .where(eq(billingEvents.stripeEventId, event.id))
      .limit(1);

    if (existingEvent.length > 0) {
      this.logger.warn(`Event ${event.id} already processed, skipping`);
      return;
    }

    // Save event to database
    await db.insert(billingEvents).values({
      stripeEventId: event.id,
      eventType: event.type,
      payload: event as any,
      processed: false,
    } as NewBillingEvent);

    // Process event based on type
    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await this.handleCheckoutSessionCompleted(event.data.object);
          break;

        case 'customer.subscription.created':
          await this.handleSubscriptionCreated(event.data.object);
          break;

        case 'customer.subscription.updated':
          await this.handleSubscriptionUpdated(event.data.object);
          break;

        case 'customer.subscription.deleted':
          await this.handleSubscriptionDeleted(event.data.object);
          break;

        case 'invoice.created':
          await this.handleInvoiceCreated(event.data.object);
          break;

        case 'invoice.finalized':
          await this.handleInvoiceFinalized(event.data.object);
          break;

        case 'invoice.paid':
          await this.handleInvoicePaid(event.data.object);
          break;

        case 'invoice.payment_failed':
          await this.handleInvoicePaymentFailed(event.data.object);
          break;

        case 'invoice.payment_succeeded':
          await this.handleInvoicePaymentSucceeded(event.data.object);
          break;

        case 'customer.subscription.trial_will_end':
          await this.handleTrialWillEnd(event.data.object);
          break;

        case 'payment_method.attached':
          await this.handlePaymentMethodAttached(event.data.object);
          break;

        case 'payment_method.detached':
          await this.handlePaymentMethodDetached(event.data.object);
          break;

        case 'charge.refunded':
          await this.handleChargeRefunded(event.data.object);
          break;

        case 'charge.dispute.created':
          await this.handleDisputeCreated(event.data.object);
          break;

        default:
          this.logger.log(`Unhandled event type: ${event.type}`);
      }

      // Mark as processed
      await db
        .update(billingEvents)
        .set({
          processed: true,
          processedAt: new Date(),
        })
        .where(eq(billingEvents.stripeEventId, event.id));
    } catch (error) {
      this.logger.error(`Error processing event ${event.id}:`, error);

      // Save error
      await db
        .update(billingEvents)
        .set({
          errorMessage: error.message,
        })
        .where(eq(billingEvents.stripeEventId, event.id));

      throw error;
    }
  }

  private async handleSubscriptionCreated(
    subscription: Stripe.Subscription,
  ): Promise<void> {
    this.logger.log(`Subscription created: ${subscription.id}`);
    // Subscription is already created in our database by the createSubscription method
    // This webhook can be used for additional processing or verification
  }

  private async handleCheckoutSessionCompleted(
    session: Stripe.Checkout.Session,
  ): Promise<void> {
    this.logger.log(`Checkout session completed: ${session.id}`);

    if (session.mode !== 'subscription' || !session.subscription) {
      return; // not a subscription checkout — ignore
    }

    const subscriptionId =
      typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription.id;

    // Retrieve the full subscription to read items, period, and metadata.
    const stripeSubscription =
      await this.stripeService.getSubscription(subscriptionId);

    const meta = (stripeSubscription.metadata ??
      session.metadata ??
      {}) as Record<string, string>;
    const workspaceId = meta.workspaceId;
    const planCode = meta.planCode;

    if (!workspaceId || !planCode) {
      this.logger.error(
        `checkout.session.completed ${session.id} missing workspaceId/planCode metadata`,
      );
      return;
    }

    const stripeCustomerId =
      typeof stripeSubscription.customer === 'string'
        ? stripeSubscription.customer
        : stripeSubscription.customer.id;

    await this.subscriptionService.persistStripeSubscription({
      workspaceId,
      planCode,
      stripeCustomerId,
      stripeSubscription,
    });

    this.logger.log(
      `Synced subscription ${subscriptionId} for workspace ${workspaceId} (${planCode})`,
    );
  }

  private async handleSubscriptionUpdated(
    subscription: Stripe.Subscription,
  ): Promise<void> {
    this.logger.log(`Subscription updated: ${subscription.id}`);

    // Find subscription in database
    const existingSub = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, subscription.id))
      .limit(1);

    if (existingSub.length === 0) {
      this.logger.warn(`Subscription ${subscription.id} not found in database`);
      return;
    }

    // Update subscription details. Period now lives on the subscription item
    // (Clover API), so read it via the shared helper.
    const sub: any = subscription;
    const period = getSubscriptionPeriod(subscription);
    const updateData: any = {
      status: subscription.status,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      updatedAt: new Date(),
    };
    if (period.start) updateData.currentPeriodStart = period.start;
    if (period.end) updateData.currentPeriodEnd = period.end;
    // Only add canceledAt if it exists (avoid explicit null for timestamps)
    if (sub.canceled_at) {
      updateData.canceledAt = new Date(sub.canceled_at * 1000);
    }
    await db
      .update(subscriptions)
      .set(updateData)
      .where(eq(subscriptions.id, existingSub[0].id));

    // If a paid→paid downgrade was scheduled, apply it once the period rolls over.
    await this.applyScheduledDowngradeIfDue(existingSub[0], period.start);
  }

  /**
   * Apply a pending paid→paid downgrade once the billing period has rolled over
   * to/past `scheduledChangeAt`. Flips the plan + usage limits and clears the
   * schedule. Downgrades to FREE are handled by cancellation (the
   * `customer.subscription.deleted` path), not here.
   */
  private async applyScheduledDowngradeIfDue(
    existing: typeof subscriptions.$inferSelect,
    newPeriodStart: Date | null,
  ): Promise<void> {
    const { scheduledPlanCode, scheduledChangeAt } = existing;
    if (!scheduledPlanCode || !scheduledChangeAt || !newPeriodStart) return;
    if (scheduledPlanCode === 'FREE') return; // handled by cancellation

    // The immediate price-swap event carries the OLD period start (well before
    // scheduledChangeAt); only the renewal event reaches it. A small tolerance
    // absorbs rounding between period_end and the next period_start.
    const TOLERANCE_MS = 60 * 1000;
    if (newPeriodStart.getTime() < scheduledChangeAt.getTime() - TOLERANCE_MS) {
      return;
    }

    const planRows = await db
      .select()
      .from(plans)
      .where(eq(plans.code, scheduledPlanCode))
      .limit(1);
    const plan = planRows[0];

    if (!plan) {
      this.logger.error(
        `Scheduled downgrade plan "${scheduledPlanCode}" not found — clearing schedule for subscription ${existing.id}`,
      );
      await db
        .update(subscriptions)
        .set({
          scheduledPlanCode: null,
          scheduledChangeAt: null,
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.id, existing.id));
      return;
    }

    await db
      .update(subscriptions)
      .set({
        planCode: scheduledPlanCode,
        scheduledPlanCode: null,
        scheduledChangeAt: null,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, existing.id));

    await db
      .update(workspaceUsage)
      .set({
        channelsLimit: plan.channelsPerWorkspace,
        membersLimit: plan.membersPerWorkspace,
        aiTokensLimit: plan.aiTokensPerMonth,
        updatedAt: new Date(),
      })
      .where(eq(workspaceUsage.workspaceId, existing.workspaceId));

    this.logger.log(
      `Applied scheduled downgrade for workspace ${existing.workspaceId} -> ${scheduledPlanCode}`,
    );
  }

  private async handleSubscriptionDeleted(
    subscription: Stripe.Subscription,
  ): Promise<void> {
    this.logger.log(`Subscription deleted: ${subscription.id}`);

    const existingSub = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, subscription.id))
      .limit(1);

    if (existingSub.length === 0) {
      return;
    }
    const existing = existingSub[0];

    // A deleted Stripe subscription means the paid period has fully ended, so
    // the workspace falls back to FREE: reset the plan, drop limits to FREE,
    // clear any schedule, and remove add-on items referencing the dead sub.
    const freeRows = await db
      .select()
      .from(plans)
      .where(eq(plans.code, 'FREE'))
      .limit(1);
    const free = freeRows[0];

    await db
      .update(subscriptions)
      .set({
        planCode: 'FREE',
        stripeSubscriptionId: null,
        status: 'active',
        cancelAtPeriodEnd: false,
        scheduledPlanCode: null,
        scheduledChangeAt: null,
        canceledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, existing.id));

    if (free) {
      await db
        .update(workspaceUsage)
        .set({
          channelsLimit: free.channelsPerWorkspace,
          membersLimit: free.membersPerWorkspace,
          aiTokensLimit: free.aiTokensPerMonth,
          extraChannelsPurchased: 0,
          extraMembersPurchased: 0,
          updatedAt: new Date(),
        })
        .where(eq(workspaceUsage.workspaceId, existing.workspaceId));
    }

    await db
      .delete(subscriptionItems)
      .where(eq(subscriptionItems.subscriptionId, existing.id));

    this.logger.log(
      `Workspace ${existing.workspaceId} reset to FREE after subscription ${subscription.id} ended`,
    );
  }

  /**
   * Look up our subscription row for an invoice (if it exists yet) and upsert the
   * invoice header + line items. Centralizes the `created`/`finalized`/`paid`
   * handlers — the upsert is idempotent, so out-of-order or duplicate webhook
   * deliveries just refresh the same row. The subscription link may be null when
   * an invoice event lands before `checkout.session.completed` persists the sub;
   * the checkout path later fills it in.
   */
  private async persistInvoiceEvent(invoice: Stripe.Invoice): Promise<void> {
    const stripeSubId = getInvoiceSubscriptionId(invoice);
    let subscriptionDbId: number | null = null;
    if (stripeSubId) {
      const sub = await db
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(eq(subscriptions.stripeSubscriptionId, stripeSubId))
        .limit(1);
      subscriptionDbId = sub[0]?.id ?? null;
    }
    await upsertInvoiceFromStripe(invoice, subscriptionDbId);
  }

  private async handleInvoiceCreated(invoice: Stripe.Invoice): Promise<void> {
    this.logger.log(`Invoice created: ${invoice.id}`);
    await this.persistInvoiceEvent(invoice);
  }

  private async handleInvoiceFinalized(invoice: Stripe.Invoice): Promise<void> {
    this.logger.log(`Invoice finalized: ${invoice.id}`);
    await this.persistInvoiceEvent(invoice);
  }

  private async handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
    this.logger.log(`Invoice paid: ${invoice.id}`);
    // The upsert reads paid status + paidAt from `status_transitions`, so this
    // both creates the invoice (if an earlier event was missed) and marks it paid.
    await this.persistInvoiceEvent(invoice);
  }

  private async handleInvoicePaymentFailed(
    invoice: Stripe.Invoice,
  ): Promise<void> {
    this.logger.error(`Invoice payment failed: ${invoice.id}`);

    // Ensure the invoice row exists before we record the failure against it
    // (the failure event can arrive before any create/finalize event).
    await this.persistInvoiceEvent(invoice);

    const existingInvoice = await db
      .select()
      .from(invoices)
      .where(eq(invoices.stripeInvoiceId, invoice.id))
      .limit(1);

    if (existingInvoice.length === 0) {
      return;
    }

    const inv: any = invoice;
    // Build update data, conditionally adding timestamps to avoid Drizzle null errors
    const updateData: any = {
      status: 'open',
      updatedAt: new Date(),
    };
    if (inv.next_payment_attempt) {
      updateData.nextPaymentAttempt = new Date(inv.next_payment_attempt * 1000);
    }
    await db
      .update(invoices)
      .set(updateData)
      .where(eq(invoices.id, existingInvoice[0].id));

    // Get subscription to find workspace
    if (!existingInvoice[0].subscriptionId) {
      return;
    }

    const subscription = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, existingInvoice[0].subscriptionId))
      .limit(1);

    if (subscription.length === 0) {
      return;
    }

    // First find or create the invoice in our database to get its ID
    const invoiceRecord = await db
      .select()
      .from(invoices)
      .where(eq(invoices.stripeInvoiceId, invoice.id))
      .limit(1);

    let invoiceId: number | null = null;
    if (invoiceRecord.length > 0) {
      invoiceId = invoiceRecord[0].id;
    }

    // Record failed payment
    const failedPayment: NewFailedPayment = {
      subscriptionId: subscription[0].id,
      invoiceId: invoiceId,
      failureReason: inv.last_payment_error?.message || 'Payment failed',
      attemptCount: inv.attempt_count || 1,
    };

    await db.insert(failedPayments).values(failedPayment);

    // Count recent failed payments for this subscription
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentFailures = await db
      .select()
      .from(failedPayments)
      .where(
        and(
          eq(failedPayments.subscriptionId, subscription[0].id),
          gt(failedPayments.createdAt, thirtyDaysAgo),
        ),
      );

    const unresolvedFailures = recentFailures.filter((f) => !f.resolved);

    // If max attempts exceeded, apply restrictions
    if (unresolvedFailures.length >= this.MAX_FAILED_ATTEMPTS) {
      await this.applyPaymentFailureRestrictions(
        subscription[0].id,
        subscription[0].workspaceId,
      );
    }

    // Update subscription status to past_due if not already
    if (subscription[0].status !== 'past_due') {
      await db
        .update(subscriptions)
        .set({
          status: 'past_due',
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.id, subscription[0].id));
    }

    this.logger.warn(
      `Failed payment recorded for subscription ${subscription[0].id}. ` +
        `Total unresolved: ${unresolvedFailures.length}/${this.MAX_FAILED_ATTEMPTS}`,
    );
  }

  private async handleInvoicePaymentSucceeded(
    invoice: Stripe.Invoice,
  ): Promise<void> {
    this.logger.log(`Invoice payment succeeded: ${invoice.id}`);

    // Find and resolve any failed payment records for this invoice
    const stripeSubId = getInvoiceSubscriptionId(invoice);
    if (stripeSubId) {
      const subscription = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.stripeSubscriptionId, stripeSubId))
        .limit(1);

      if (subscription.length > 0) {
        // Resolve all failed payments for this subscription
        await db
          .update(failedPayments)
          .set({
            resolved: true,
            resolvedAt: new Date(),
          })
          .where(eq(failedPayments.subscriptionId, subscription[0].id));

        // Remove restrictions if any were applied
        await this.removePaymentFailureRestrictions(
          subscription[0].id,
          subscription[0].workspaceId,
        );

        // Update subscription status to active
        if (subscription[0].status === 'past_due') {
          await db
            .update(subscriptions)
            .set({
              status: 'active',
              updatedAt: new Date(),
            })
            .where(eq(subscriptions.id, subscription[0].id));
        }
      }
    }
  }

  private async handleTrialWillEnd(
    subscription: Stripe.Subscription,
  ): Promise<void> {
    this.logger.log(`Trial ending soon for subscription: ${subscription.id}`);

    // Find subscription in database
    const existingSub = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, subscription.id))
      .limit(1);

    if (existingSub.length === 0) {
      return;
    }

    // This is typically used to send email notifications
    // The actual notification would be handled by an email service
    this.logger.log(
      `Subscription ${existingSub[0].id} trial ends at ${existingSub[0].trialEnd}`,
    );
  }

  private async handlePaymentMethodAttached(
    paymentMethod: Stripe.PaymentMethod,
  ): Promise<void> {
    this.logger.log(`Payment method attached: ${paymentMethod.id}`);

    const pm: any = paymentMethod;
    if (!pm.customer) {
      return;
    }

    // Find user by Stripe customer ID
    const customer = await db
      .select()
      .from(stripeCustomers)
      .where(eq(stripeCustomers.stripeCustomerId, pm.customer as string))
      .limit(1);

    if (customer.length === 0) {
      return;
    }

    // Check if payment method already exists
    const existing = await db
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.stripePaymentMethodId, paymentMethod.id))
      .limit(1);

    if (existing.length > 0) {
      return; // Already saved
    }

    // Save payment method
    await db.insert(paymentMethods).values({
      stripeCustomerId: pm.customer as string,
      stripePaymentMethodId: paymentMethod.id,
      type: paymentMethod.type || 'card',
      cardBrand: pm.card?.brand || null,
      cardLast4: pm.card?.last4 || null,
      cardExpMonth: pm.card?.exp_month || null,
      cardExpYear: pm.card?.exp_year || null,
      isDefault: false,
    });
  }

  private async handlePaymentMethodDetached(
    paymentMethod: Stripe.PaymentMethod,
  ): Promise<void> {
    this.logger.log(`Payment method detached: ${paymentMethod.id}`);

    // Remove from database
    await db
      .delete(paymentMethods)
      .where(eq(paymentMethods.stripePaymentMethodId, paymentMethod.id));
  }

  private async handleChargeRefunded(charge: Stripe.Charge): Promise<void> {
    this.logger.log(`Charge refunded: ${charge.id}`);

    // Log the refund for auditing
    const chr: any = charge;
    this.logger.log(
      `Refund amount: ${chr.amount_refunded} cents for invoice ${chr.invoice}`,
    );

    // If you need to track refunds in your database, do it here
  }

  private async handleDisputeCreated(dispute: Stripe.Dispute): Promise<void> {
    this.logger.error(`Dispute created: ${dispute.id}`);

    // Disputes are serious and require attention
    const disp: any = dispute;
    this.logger.error(
      `Dispute for charge ${disp.charge}, reason: ${dispute.reason}, amount: ${dispute.amount}`,
    );

    // You might want to:
    // - Send urgent notification to admin
    // - Restrict the user's account
    // - Track in a disputes table
  }

  // Apply restrictions when payment fails too many times
  private async applyPaymentFailureRestrictions(
    subscriptionId: number,
    workspaceId: string,
  ): Promise<void> {
    this.logger.warn(
      `Applying payment failure restrictions to workspace ${workspaceId}`,
    );

    // Option 1: Reduce limits to free plan levels
    // This prevents new resource creation but doesn't delete existing resources
    await db
      .update(workspaceUsage)
      .set({
        channelsLimit: 3, // Free plan limit
        membersLimit: 1, // Free plan limit
        updatedAt: new Date(),
      })
      .where(eq(workspaceUsage.workspaceId, workspaceId));

    // Option 2: Mark subscription as restricted
    await db
      .update(subscriptions)
      .set({
        status: 'past_due',
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, subscriptionId));

    this.logger.log(
      `Restrictions applied to workspace ${workspaceId} due to payment failures`,
    );
  }

  // Remove restrictions when payment succeeds
  private async removePaymentFailureRestrictions(
    subscriptionId: number,
    workspaceId: string,
  ): Promise<void> {
    this.logger.log(
      `Removing payment failure restrictions from workspace ${workspaceId}`,
    );

    // Get the subscription to find the plan
    const subscription = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1);

    if (subscription.length === 0) {
      return;
    }

    // Restore plan limits based on plan code
    const planLimits: Record<string, { channels: number; members: number }> = {
      FREE: { channels: 3, members: 1 },
      PRO: { channels: 10, members: 5 },
      MAX: { channels: 25, members: 15 },
    };

    const limits = planLimits[subscription[0].planCode] || planLimits.FREE;

    // Get current usage to preserve extra purchased add-ons
    const usage = await db
      .select()
      .from(workspaceUsage)
      .where(eq(workspaceUsage.workspaceId, workspaceId))
      .limit(1);

    if (usage.length > 0) {
      await db
        .update(workspaceUsage)
        .set({
          channelsLimit: limits.channels,
          membersLimit: limits.members,
          updatedAt: new Date(),
        })
        .where(eq(workspaceUsage.workspaceId, workspaceId));
    }

    this.logger.log(
      `Restrictions removed from workspace ${workspaceId}, limits restored`,
    );
  }

  // Helper method to check if a subscription has payment restrictions
  async hasPaymentRestrictions(subscriptionId: number): Promise<boolean> {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const unresolvedFailures = await db
      .select()
      .from(failedPayments)
      .where(
        and(
          eq(failedPayments.subscriptionId, subscriptionId),
          gt(failedPayments.createdAt, thirtyDaysAgo),
        ),
      );

    const unresolved = unresolvedFailures.filter((f) => !f.resolved);
    return unresolved.length >= this.MAX_FAILED_ATTEMPTS;
  }

  // Get failed payment history for a subscription
  async getFailedPaymentHistory(subscriptionId: number): Promise<any[]> {
    const failures = await db
      .select()
      .from(failedPayments)
      .where(eq(failedPayments.subscriptionId, subscriptionId));

    return failures.map((f) => ({
      id: f.id,
      invoiceId: f.invoiceId,
      failureReason: f.failureReason,
      attemptCount: f.attemptCount,
      userNotified: f.userNotified,
      featuresRestricted: f.featuresRestricted,
      restrictionDate: f.restrictionDate,
      resolved: f.resolved,
      resolvedAt: f.resolvedAt,
      createdAt: f.createdAt,
    }));
  }
}
