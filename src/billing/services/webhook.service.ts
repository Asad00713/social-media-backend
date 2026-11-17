import { Injectable, Logger } from '@nestjs/common';
import { eq, and, gt, inArray } from 'drizzle-orm';
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
  workspace,
  NewBillingEvent,
  NewFailedPayment,
} from '../../drizzle/schema';
import { SubscriptionService } from './subscription.service';
import { SubscriptionLookupService } from './subscription-lookup.service';
import {
  getInvoiceSubscriptionId,
  upsertInvoiceFromStripe,
} from './invoice-sync.util';
import { getSubscriptionPeriod } from './subscription-sync.util';
import { StripeService } from '../../stripe/stripe.service';
import { PaymentAlertsService } from './payment-alerts.service';
import {
  endStripeProviderRows,
  refreshStripeProviderRowStatus,
} from '../providers/stripe-provider-row.util';
import { BillingEmailService, billingEmailKey } from './billing-email.service';
import { liveWorkspaces } from '../../posts/soft-delete/soft-delete';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  // Configuration for failed payment handling
  private readonly MAX_FAILED_ATTEMPTS = 3;
  private readonly GRACE_PERIOD_DAYS = 7;

  constructor(
    private subscriptionService: SubscriptionService,
    private stripeService: StripeService,
    private readonly lookup: SubscriptionLookupService,
    private readonly billingEmail: BillingEmailService,
    private readonly paymentAlerts: PaymentAlertsService,
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
          await this.handleSubscriptionUpdated(
            event.data.object,
            event.data.previous_attributes,
          );
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
          await this.handleInvoicePaymentFailed(event.data.object, event.id);
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
    const planCode = meta.planCode;

    // The subscription is account-scoped, so the account is what we need.
    // `workspaceId` is still written for context (and by checkouts created
    // before this change) — fall back to its owner so a checkout already in
    // flight at deploy time still lands.
    const userId =
      meta.userId ??
      (meta.workspaceId
        ? await this.lookup.getOwnerId(meta.workspaceId)
        : null);

    if (!userId || !planCode) {
      this.logger.error(
        `checkout.session.completed ${session.id} missing userId/planCode metadata`,
      );
      return;
    }

    const stripeCustomerId =
      typeof stripeSubscription.customer === 'string'
        ? stripeSubscription.customer
        : stripeSubscription.customer.id;

    await this.subscriptionService.persistStripeSubscription({
      userId,
      planCode,
      stripeCustomerId,
      stripeSubscription,
    });

    this.logger.log(
      `Synced subscription ${subscriptionId} for user ${userId} (${planCode})`,
    );
  }

  private async handleSubscriptionUpdated(
    subscription: Stripe.Subscription,
    previousAttributes?: Partial<Stripe.Subscription>,
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

    // The same facts, into the OTHER table that holds them. `subscriptions`
    // is what the dashboard renders; `provider_subscriptions` is what
    // `isLive()` / `hasLiveBasePlan()` read to decide whether this account is
    // being billed and whether a cancel must reach Stripe. Writing only the
    // first left the second tracking whatever we last did through our own API
    // and blind to everything Stripe does on its own — a dunning failure, a
    // recovery, or a cancellation scheduled from the Stripe Dashboard, which
    // arrives ONLY as this event. Refresh-not-upsert: see the util.
    await refreshStripeProviderRowStatus({
      subscriptionId: existingSub[0].id,
      stripeSubscription: subscription,
    });

    // A cancellation was just scheduled (from our app or the Stripe
    // Dashboard). The edge is read from STRIPE's record of the change, not
    // from our row: the app's own cancel writes `cancelAtPeriodEnd` before
    // this event arrives, so our row already says true by then. Every later
    // update on a subscription that already cancels carries no such change.
    if (
      subscription.cancel_at_period_end === true &&
      previousAttributes?.cancel_at_period_end === false
    ) {
      await this.safely('cancel scheduled', () =>
        this.emailCancelScheduled(
          existingSub[0],
          subscription.cancel_at
            ? new Date(subscription.cancel_at * 1000)
            : period.end,
        ),
      );
    }

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

    // The subscription covers every workspace the account owns — writing one
    // usage row would strand the rest on the OLD, higher limits.
    const addons = await this.lookup.getAddonQuantities(existing.id);
    await this.lookup.applyLimitsToAllWorkspaces(
      existing.userId,
      scheduledPlanCode,
      addons,
    );

    this.logger.log(
      `Applied scheduled downgrade for user ${existing.userId} -> ${scheduledPlanCode}`,
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
    // The write below resets the plan; the email names the one that ended.
    const endedPlanCode = existing.planCode;
    const endedPeriodEnd = existing.currentPeriodEnd;

    // End the PROVIDER rows first. They name the subscription Stripe has just
    // deleted, and the write below nulls `stripe_subscription_id` — which is
    // what `clearStaleStripeSubscription` keys on, so once that column is NULL
    // nothing else can ever reach these rows to clean them up.
    //
    // Left behind, the BASE_PLAN row sat at `provider_status = 'active'`,
    // `is_default = true`, naming a dead id. The account read as FREE locally
    // while `hasLiveBasePlan()` — which every paid/unpaid branch keys on —
    // answered TRUE from it (a row exists, so the legacy fallback never fires).
    // The customer's next attempt to re-subscribe took the already-paying
    // branch, handed Stripe the deleted id and 500'd with `resource_missing`,
    // every time: they could not re-subscribe at all. The `is_default` flag
    // also squatted on the one slot the partial unique index allows, so a
    // later Lemon Squeezy signup would hit 23505 after LS had already charged.
    //
    // Ordered first so a crash mid-handler leaves the rows dead rather than
    // live-looking, which is the cheaper of the two wrong states.
    await endStripeProviderRows(existing.id);

    // A deleted Stripe subscription means the paid period has fully ended, so
    // the ACCOUNT falls back to FREE: reset the plan, drop limits to FREE on
    // every owned workspace, clear any schedule, and remove add-on items
    // referencing the dead sub.
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

    // The add-on items are deleted just below, so pass zeroes explicitly
    // rather than reading quantities that are about to disappear.
    await this.lookup.applyLimitsToAllWorkspaces(existing.userId, 'FREE', {
      extraChannels: 0,
      extraMembers: 0,
      extraWorkspaces: 0,
      extraAiTokens: 0,
    });

    // The purchased extras die with the subscription.
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
            .where(
              and(eq(workspace.ownerId, existing.userId), liveWorkspaces()),
            ),
        ),
      );

    await db
      .delete(subscriptionItems)
      .where(eq(subscriptionItems.subscriptionId, existing.id));

    this.logger.log(
      `User ${existing.userId} reset to FREE after subscription ${subscription.id} ended`,
    );

    if (endedPlanCode !== 'FREE') {
      await this.safely('plan ended', async () => {
        await this.billingEmail.planChanged({
          userId: existing.userId,
          kind: 'ended',
          fromPlan: await this.billingEmail.planName(endedPlanCode),
          toPlan: 'Free',
          billed: null,
          nextCharge: null,
          endsOn: null,
          dedupeKey: billingEmailKey(
            'plan-changed',
            existing.userId,
            'ended',
            subscription.id,
            endedPeriodEnd?.getTime() ?? Date.now(),
          ),
        });
      });
    }
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
    eventId: string,
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

    await this.safely('payment failed', () =>
      this.emailPaymentFailed(invoice, subscription[0]),
    );

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

    // If max attempts exceeded, apply restrictions. The "moved to Free" email
    // goes out once per episode; applyPaymentFailureRestrictions decides that.
    if (unresolvedFailures.length >= this.MAX_FAILED_ATTEMPTS) {
      await this.applyPaymentFailureRestrictions(
        subscription[0].id,
        subscription[0].userId,
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

    // One alert per failure EVENT. Keyed on the event id, not the invoice's
    // `attempt_count`: a manual retry that fails again does not bump the count
    // but is a new event. Redelivery of the same event is stopped earlier by
    // the billing_events check, and the alert claim is unique besides.
    await this.paymentAlerts.paymentFailed({
      userId: subscription[0].userId,
      provider: 'stripe',
      alertKey: `stripe:failed:${eventId}`,
      amountMinor:
        typeof invoice.amount_due === 'number' ? invoice.amount_due : null,
      card: null, // the saved default card; the invoice does not carry one
      // An Invoice carries no decline message (that lives on the
      // PaymentIntent), so the notification uses its default sentence rather
      // than a placeholder reading "failed: Payment failed".
      reason: null,
    });
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
        // Read BEFORE resolving: was this account in dunning when the payment
        // landed? `subscription.updated` may already have flipped the status
        // to active, so unresolved failure rows count as evidence too.
        const unresolved = await db
          .select({ id: failedPayments.id })
          .from(failedPayments)
          .where(
            and(
              eq(failedPayments.subscriptionId, subscription[0].id),
              eq(failedPayments.resolved, false),
            ),
          )
          .limit(1);
        const wasPastDue =
          subscription[0].status === 'past_due' || unresolved.length > 0;

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
          subscription[0].userId,
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

        await this.paymentAlerts.paymentSucceeded({
          userId: subscription[0].userId,
          provider: 'stripe',
          alertKey: `stripe:recovered:${invoice.id}`,
          amountMinor:
            typeof invoice.amount_paid === 'number'
              ? invoice.amount_paid
              : null,
          planCode: subscription[0].planCode,
          wasPastDue,
        });
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

    this.logger.log(
      `Subscription ${existingSub[0].id} trial ends at ${existingSub[0].trialEnd}`,
    );

    // The warning is for a trial that is still running and will convert or
    // lapse. Stripe also sends it when a trial is ended early (the trial end
    // is then now, or already past) and for a subscription already set to
    // cancel: neither person should be told "choose a plan".
    const trialEndMs = subscription.trial_end
      ? subscription.trial_end * 1000
      : 0;
    if (
      subscription.status !== 'trialing' ||
      subscription.cancel_at_period_end ||
      trialEndMs <= Date.now()
    ) {
      this.logger.log(
        `Trial-ending email skipped for subscription ${existingSub[0].id}: no longer a live trial`,
      );
      return;
    }

    await this.safely('trial ending', () =>
      this.emailTrialEnding(existingSub[0], subscription),
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
    userId: string,
  ): Promise<void> {
    this.logger.warn(
      `Applying payment failure restrictions to user ${userId}'s workspaces`,
    );

    // Reduce limits to FREE levels across EVERY workspace the account owns —
    // restricting only one would leave the others on the unpaid-for plan's
    // allowance. This prevents new resource creation but deletes nothing.
    // Add-ons are zeroed too: they are part of what went unpaid.
    await this.lookup.applyLimitsToAllWorkspaces(userId, 'FREE', {
      extraChannels: 0,
      extraMembers: 0,
      extraWorkspaces: 0,
      extraAiTokens: 0,
    });

    // Zero the stored extras as well. Passing zeroes above only affects the
    // base limits the fan-out writes; every reader computes the ceiling as
    // `limit + extraPurchased`, so leaving the purchased columns populated made
    // the "restriction" land at 3 + 3 = 6 channels instead of FREE's 3. The
    // sibling paths (handleSubscriptionDeleted, downgradeToFree) already do
    // this — this path was the outlier.
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
            .where(and(eq(workspace.ownerId, userId), liveWorkspaces())),
        ),
      );

    // Mark subscription as restricted
    await db
      .update(subscriptions)
      .set({
        status: 'past_due',
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, subscriptionId));

    this.logger.log(
      `Restrictions applied to user ${userId} due to payment failures`,
    );

    // Every failure past the third lands here, but the person is told once
    // per episode. The flag lives on the unresolved failures (a payment that
    // succeeds resolves them), so the next episode starts clean. The flip is
    // one conditional UPDATE, not a read and a write, so two failures
    // arriving together cannot both send.
    const flipped = await db
      .update(failedPayments)
      .set({ featuresRestricted: true, restrictionDate: new Date() })
      .where(
        and(
          eq(failedPayments.subscriptionId, subscriptionId),
          eq(failedPayments.resolved, false),
          eq(failedPayments.featuresRestricted, false),
        ),
      )
      .returning({ id: failedPayments.id });
    if (!(await this.startsEpisode(subscriptionId, flipped))) return;

    await this.safely('payment restricted', () =>
      this.emailPaymentRestricted(subscriptionId, userId),
    );
  }

  /**
   * Whether this flip restricted the episode, rather than a later failure of
   * an episode already restricted (that one flips only its own new row): it
   * holds the episode's first unresolved failure. Of two concurrent flips,
   * only one can take that row, because Postgres re-checks
   * `features_restricted = false` on it after the other commits. The episode
   * is the same 30-day window the caller counts, so an unpaid failure older
   * than that never stands in for a new episode's first.
   */
  private async startsEpisode(
    subscriptionId: number,
    flipped: { id: number }[],
  ): Promise<boolean> {
    if (flipped.length === 0) return false;
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const unresolved = await db
      .select({ id: failedPayments.id })
      .from(failedPayments)
      .where(
        and(
          eq(failedPayments.subscriptionId, subscriptionId),
          eq(failedPayments.resolved, false),
          gt(failedPayments.createdAt, thirtyDaysAgo),
        ),
      );
    const first = Math.min(...unresolved.map((f) => f.id));
    return flipped.some((f) => f.id === first);
  }

  // ---- Billing emails ------------------------------------------------------
  // A mail problem must never fail the webhook: Stripe would retry the event
  // and every database write above would be applied twice.

  private async safely(what: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.logger.warn(
        `Billing email (${what}) skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The newest saved card for the customer, preferring the default one. */
  private async storedCard(
    stripeCustomerId: string | null,
  ): Promise<{ brand: string | null; last4: string | null } | null> {
    if (!stripeCustomerId) return null;
    const rows = await db
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.stripeCustomerId, stripeCustomerId));
    const cards = rows.filter((row) => row.cardLast4);
    const card =
      cards.find((row) => row.isDefault) ??
      [...cards].sort(
        (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
      )[0];
    return card ? { brand: card.cardBrand, last4: card.cardLast4 } : null;
  }

  private async emailPaymentFailed(
    invoice: Stripe.Invoice,
    sub: typeof subscriptions.$inferSelect,
  ): Promise<void> {
    // The fields this email reads. Not all are on the SDK's Invoice type (the
    // dunning facts moved between API versions), so name what is relied on.
    const inv = invoice as unknown as {
      amount_due?: number;
      currency?: string;
      attempt_count?: number;
      next_payment_attempt?: number | null;
    };
    const card = await this.storedCard(sub.stripeCustomerId);
    await this.billingEmail.paymentFailed({
      userId: sub.userId,
      planName: await this.billingEmail.planName(sub.planCode),
      amountCents: inv.amount_due ?? 0,
      currency: inv.currency ?? 'usd',
      cardLast4: card?.last4 ?? null,
      cardBrand: card?.brand ?? null,
      // The invoice carries no bank reason (`last_payment_error` is a
      // PaymentIntent field) and fetching it would cost a Stripe call per
      // failure, so the email simply omits the sentence.
      reason: null,
      nextAttempt: inv.next_payment_attempt
        ? new Date(inv.next_payment_attempt * 1000)
        : null,
      // One mail per attempt: Stripe redelivering this event keeps the key,
      // the next dunning attempt (attempt_count + 1) gets a new one.
      dedupeKey: billingEmailKey(
        'payment-failed',
        invoice.id ?? sub.id,
        inv.attempt_count || 1,
      ),
    });
  }

  private async emailTrialEnding(
    sub: typeof subscriptions.$inferSelect,
    stripeSubscription: Stripe.Subscription,
  ): Promise<void> {
    const trialEnd = stripeSubscription.trial_end
      ? new Date(stripeSubscription.trial_end * 1000)
      : sub.trialEnd;
    if (!trialEnd) return;
    // The provider's word wins: a default payment method on the subscription
    // means a card is on file. Otherwise fall back to the cards we saved for
    // the customer; with no customer id there is nothing to say either way.
    const hasCard = stripeSubscription.default_payment_method
      ? true
      : sub.stripeCustomerId
        ? (await this.storedCard(sub.stripeCustomerId)) !== null
        : null;
    await this.billingEmail.trialEnding({
      userId: sub.userId,
      subscriptionId: sub.id,
      trialEnd,
      planCode: sub.planCode,
      hasCard,
    });
  }

  private async emailCancelScheduled(
    sub: typeof subscriptions.$inferSelect,
    endsOn: Date | null,
  ): Promise<void> {
    await this.billingEmail.planChanged({
      userId: sub.userId,
      kind: 'cancel_scheduled',
      fromPlan: await this.billingEmail.planName(sub.planCode),
      toPlan: 'Free',
      billed: null,
      nextCharge: null,
      endsOn,
      dedupeKey: billingEmailKey(
        'plan-changed',
        sub.userId,
        'cancel_scheduled',
        sub.stripeSubscriptionId ?? sub.id,
        endsOn?.getTime() ?? Date.now(),
      ),
    });
  }

  private async emailPaymentRestricted(
    subscriptionId: number,
    userId: string,
  ): Promise<void> {
    const [sub] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1);
    if (!sub) return;
    await this.billingEmail.planChanged({
      userId,
      kind: 'payment_restricted',
      fromPlan: await this.billingEmail.planName(sub.planCode),
      toPlan: 'Free',
      billed: null,
      nextCharge: null,
      endsOn: null,
      // The caller sends this once per episode; the period keeps the key
      // stable should a delivery repeat inside the outbox's window.
      dedupeKey: billingEmailKey(
        'plan-changed',
        userId,
        'payment_restricted',
        sub.stripeSubscriptionId ?? sub.id,
        sub.currentPeriodEnd?.getTime() ?? Date.now(),
      ),
    });
  }

  // Remove restrictions when payment succeeds
  private async removePaymentFailureRestrictions(
    subscriptionId: number,
    userId: string,
  ): Promise<void> {
    this.logger.log(
      `Removing payment failure restrictions from user ${userId}'s workspaces`,
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

    // Restore the real plan limits (plus the add-ons that survived) on every
    // owned workspace. This used to consult a hard-coded FREE/PRO/MAX table,
    // which silently mis-restored BASIC and ENTERPRISE and dropped add-ons.
    const addons = await this.lookup.getAddonQuantities(subscriptionId);
    await this.lookup.applyLimitsToAllWorkspaces(
      userId,
      subscription[0].planCode,
      addons,
    );

    this.logger.log(
      `Restrictions removed from user ${userId}, limits restored`,
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
