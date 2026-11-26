import { Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import {
  plans,
  providerSubscriptions,
  subscriptions,
} from '../../drizzle/schema';
import {
  BillingEmailService,
  billingEmailKey,
} from './billing-email.service';
import {
  isPaddleTerminal,
  mapPaddleStatus,
} from '../providers/paddle-status.util';
import {
  verifyPaddleSignature,
  PADDLE_WEBHOOK_SECRET_ENV,
} from '../providers/paddle-signature.util';
import type {
  PaddleSubscription,
  PaddleTransaction,
} from '../providers/paddle.types';
import { rehomeDefault } from './rehome-default.util';
import {
  revokeAddon,
  revokeBasePlan,
} from './revoke-entitlements.util';
import { SubscriptionLookupService } from './subscription-lookup.service';
import { PaymentAlertsService } from './payment-alerts.service';

const PROVIDER = 'paddle' as const;

/** Events that carry a Subscription entity as `data`. */
const SUBSCRIPTION_EVENTS = new Set([
  'subscription.created',
  'subscription.activated',
  'subscription.updated',
  'subscription.canceled',
  'subscription.paused',
  'subscription.resumed',
  'subscription.past_due',
  'subscription.trialing',
]);

/** Events that carry a Transaction entity as `data`. */
const TRANSACTION_EVENTS = new Set([
  'transaction.completed',
  'transaction.payment_failed',
  'transaction.past_due',
]);

/** Paddle's envelope. `data` IS the entity, not a wrapper around it. */
interface PaddleEnvelope<T = unknown> {
  event_id?: string;
  event_type?: string;
  occurred_at?: string;
  notification_id?: string;
  data?: T;
}

/** The provider row an event is about. */
interface Target {
  rowId: number;
  subscriptionId: number;
  /** Read from the ROW, never inferred from a price id. */
  itemType: string;
  isDefault: boolean;
  providerStatus: string | null;
}

/**
 * Paddle webhooks.
 *
 * Shaped on `LemonSqueezyWebhookService`, and the two hard-won rules from it
 * carry over unchanged:
 *
 * 1. **Ordering is not guaranteed.** A row already terminal refuses to leave
 *    that state, so a late `subscription.updated` carrying `active` that
 *    overtook a `subscription.canceled` cannot resurrect a dead account,
 *    restore its limits, or re-claim the single `is_default` slot a fresh
 *    signup at another provider may already hold.
 *
 * 2. **Anything that ends a subscription must leave `provider_subscriptions`
 *    telling the truth** — the row written dead AND `is_default` released, or
 *    the account reads as paying while nothing bills it and can never
 *    re-subscribe, because the partial unique index allows exactly one
 *    `is_default` row and a dead one keeps the slot.
 *
 * What differs from Lemon Squeezy:
 *
 * - **One subscription, N items.** An add-on is a line on the base plan's
 *   subscription, not a subscription of its own, so there is exactly one
 *   provider row per account carrying `is_default` and an add-on never fires
 *   its own lifecycle event. Add-on removal arrives as a
 *   `subscription.updated` whose `items` no longer list that price.
 * - **Cancel-at-period-end has no status.** It is `active` plus
 *   `scheduled_change.action === 'cancel'`; see `paddle-status.util.ts`.
 * - **The subscription is born from a transaction.** `createCheckout` writes
 *   no row, so `subscription.created` is where the first row appears, and the
 *   workspace it belongs to is read from the custom data the checkout set.
 */
@Injectable()
export class PaddleWebhookService {
  private readonly logger = new Logger(PaddleWebhookService.name);

  constructor(
    private readonly lookup: SubscriptionLookupService,
    private readonly paymentAlerts: PaymentAlertsService,
    private readonly billingEmail: BillingEmailService,
  ) {}

  // --------------------------------------------------------------- signature

  /**
   * Whether this body really came from Paddle.
   *
   * The work is in `paddle-signature.util.ts`; this reads the secret and
   * logs. Returns FALSE when the secret is unset — an unsigned, publicly
   * reachable endpoint that mutates billing state is worse than a dropped
   * webhook Paddle will retry.
   */
  verifySignature(raw: Buffer, signature: string | undefined): boolean {
    const result = verifyPaddleSignature(
      raw,
      signature,
      process.env[PADDLE_WEBHOOK_SECRET_ENV],
    );
    if (!result.ok) {
      if (result.reason === 'no-secret') {
        this.logger.error(
          `${PADDLE_WEBHOOK_SECRET_ENV} is not set; rejecting the webhook ` +
            'rather than trusting an unverified body.',
        );
      } else {
        this.logger.warn(`Rejected a Paddle webhook: ${result.reason}`);
      }
    }
    return result.ok;
  }

  // ------------------------------------------------------------------ events

  async handleEvent(eventType: string, payload: unknown): Promise<void> {
    const envelope = (payload ?? {}) as PaddleEnvelope;

    if (SUBSCRIPTION_EVENTS.has(eventType)) {
      await this.handleSubscription(
        eventType,
        (envelope.data ?? {}) as PaddleSubscription,
      );
      return;
    }
    if (TRANSACTION_EVENTS.has(eventType)) {
      await this.handleTransaction(
        eventType,
        (envelope.data ?? {}) as PaddleTransaction,
      );
      return;
    }

    this.logger.log(`Ignoring unhandled Paddle event ${eventType}`);
  }

  // ----------------------------------------------------------- subscriptions

  private async handleSubscription(
    eventType: string,
    sub: PaddleSubscription,
  ): Promise<void> {
    const paddleId = strOf(sub.id);
    if (!paddleId) {
      this.logger.warn(`${eventType} arrived with no subscription id`);
      return;
    }

    let target = await this.findTarget(paddleId);

    // `subscription.created` is the ONLY event that may create a row: it is
    // the completion of a checkout we started. Every other event refreshes an
    // existing one — an event for a subscription we hold no row for must not
    // claim `is_default` for an account whose provider is not yet decided.
    if (!target && eventType === 'subscription.created') {
      target = await this.createRowFromCheckout(paddleId, sub);
    }

    // The plan the checkout bought, applied on EVERY `subscription.created`
    // rather than only the one that creates the row.
    //
    // Putting it inside `createRowFromCheckout` looked equivalent and is not:
    // that runs only when no row exists yet. Paddle delivers at-least-once
    // and out of order, so a redelivered or replayed `subscription.created`
    // finds the row already there, skips the creation — and would skip the
    // plan with it, leaving an account paying for Basic on Free's limits with
    // no way to recover short of editing the database. Writing it here makes
    // the event idempotent in the way Paddle's delivery guarantees require.
    // Found by replaying a real sandbox event, 2026-11-26.
    if (target && eventType === 'subscription.created') {
      const custom = (sub as { custom_data?: Record<string, unknown> | null })
        .custom_data;
      await this.applyPurchasedPlan(target.subscriptionId, custom ?? {});
    }

    if (!target) {
      this.logger.warn(
        `No Paddle provider row for subscription ${paddleId} (${eventType}); ` +
          'nothing to update.',
      );
      return;
    }

    await this.applyStatus(target, sub);
  }

  /**
   * The first provider row for a subscription Paddle has just created.
   *
   * The account is found through the custom data the checkout set
   * (`createCheckout` puts `user_id` and `workspace_id` on the transaction,
   * and Paddle copies a transaction's custom data onto the subscription it
   * creates). Nothing is inferred from the email: two accounts can share one,
   * and billing the wrong one is not recoverable by a later event.
   */
  private async createRowFromCheckout(
    paddleId: string,
    sub: PaddleSubscription,
  ): Promise<Target | null> {
    const custom = (sub as { custom_data?: Record<string, unknown> | null })
      .custom_data;
    const userId = strOf(custom?.user_id);
    if (!userId) {
      this.logger.warn(
        `Paddle subscription ${paddleId} carries no user_id in custom_data; ` +
          'cannot attach it to an account.',
      );
      return null;
    }

    const ours = (await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))) as { id: number }[];
    const subscriptionId = ours[0]?.id;
    if (!subscriptionId) {
      this.logger.warn(
        `No subscription row for user ${userId} (Paddle ${paddleId}).`,
      );
      return null;
    }

    // `isDefault` TRUE here, and only here: this is the account's base plan
    // arriving, and the flag names the provider billing the account. The
    // partial unique index raises 23505 if something else already holds it,
    // which is the right outcome — a second live provider on one account is a
    // state to fail on, not to overwrite silently.
    const inserted = (await db
      .insert(providerSubscriptions)
      .values({
        subscriptionId,
        provider: PROVIDER,
        itemType: 'BASE_PLAN',
        providerSubscriptionId: paddleId,
        providerCustomerId: strOf(sub.customer_id),
        providerPriceId: strOf(sub.items?.[0]?.price?.id),
        providerQuantity: sub.items?.[0]?.quantity ?? 1,
        providerStatus: sub.status ?? null,
        isDefault: true,
      })
      .onConflictDoUpdate({
        target: [
          providerSubscriptions.subscriptionId,
          providerSubscriptions.provider,
          providerSubscriptions.itemType,
        ],
        set: {
          providerSubscriptionId: paddleId,
          providerCustomerId: strOf(sub.customer_id),
          providerStatus: sub.status ?? null,
          updatedAt: new Date(),
        },
      })
      .returning({
        rowId: providerSubscriptions.id,
        subscriptionId: providerSubscriptions.subscriptionId,
        itemType: providerSubscriptions.itemType,
        isDefault: providerSubscriptions.isDefault,
        providerStatus: providerSubscriptions.providerStatus,
      })) as Target[];

    this.logger.log(
      `Attached Paddle subscription ${paddleId} to subscription ` +
        `${subscriptionId} for user ${userId}`,
    );

    return inserted[0] ?? null;
  }

  /**
   * Put the account on the plan its checkout named.
   *
   * The code is read from `custom_data`, which we set when creating the
   * transaction — but it arrives back over a public endpoint, so it is
   * validated against the `plans` table before it reaches the column every
   * limit check reads. (Signature verification already proves the body is
   * Paddle's; this guards against our own stale or mistyped metadata.)
   *
   * A code we cannot place is logged and skipped rather than thrown. The
   * payment has already happened and the provider row is already written;
   * throwing would 500 a delivery and lose the attachment too, which is
   * strictly worse than an account on the wrong plan that a human can fix.
   */
  private async applyPurchasedPlan(
    subscriptionId: number,
    custom: Record<string, unknown>,
  ): Promise<void> {
    const planCode = strOf(custom['plan_code']);
    if (!planCode) {
      this.logger.error(
        `Paddle checkout for account ${subscriptionId} carried no plan_code; ` +
          'the account keeps its current plan.',
      );
      return;
    }

    const known = (await db
      .select({ code: plans.code })
      .from(plans)
      .where(eq(plans.code, planCode))) as { code: string }[];

    if (known.length === 0) {
      this.logger.error(
        `Paddle checkout for account ${subscriptionId} named plan ` +
          `"${planCode}", which is not in the plans table; ignoring it.`,
      );
      return;
    }

    await db
      .update(subscriptions)
      .set({ planCode, updatedAt: new Date() })
      .where(eq(subscriptions.id, subscriptionId));

    // `plan_code` is what the UI shows; `workspace_usage` is what actually
    // GATES. They are separate rows and nothing on this path wrote the second
    // one, so the account read "Basic plan" while still holding Free's
    // channel, seat, AI and storage limits — paying for a plan it could not
    // use. Only plan CHANGES and the Stripe webhook refreshed limits; a first
    // purchase through a hosted checkout had no such moment. This is it.
    //
    // Add-ons are zero here on purpose: this is the base plan arriving, and
    // any add-on bought later fans its own limits out through
    // `addon.service`. Passing anything else would count a purchase twice.
    const owner = (await db
      .select({ userId: subscriptions.userId })
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))) as { userId: string }[];
    const userId = owner[0]?.userId;

    if (userId) {
      await this.lookup.applyLimitsToAllWorkspaces(userId, planCode, {
        extraChannels: 0,
        extraMembers: 0,
        extraWorkspaces: 0,
        extraAiTokens: 0,
      });
    }

    this.logger.log(
      `Account ${subscriptionId} is now on ${planCode} (Paddle checkout).`,
    );
  }

  /**
   * Write what the event says, refusing to move a dead row back to life.
   *
   * Two tables: the provider row (what Paddle is doing) and our own
   * subscription row (what the customer is entitled to).
   */
  private async applyStatus(
    target: Target,
    sub: PaddleSubscription,
  ): Promise<void> {
    const status = (sub.status ?? '').toLowerCase();

    // ORDERING IS NOT GUARANTEED. A terminal row must not be revived by a
    // stale event delivered late: `canceled` then `active` arriving out of
    // order would restore the customer's limits and re-claim an `is_default`
    // slot something else may already hold.
    const current = (target.providerStatus ?? '').toLowerCase();
    if (isPaddleTerminal(current) && !isPaddleTerminal(status)) {
      this.logger.warn(
        `Ignoring a stale Paddle event: provider row ${target.rowId} is ` +
          `already ${current} and the event carries ${status || 'no status'}.`,
      );
      return;
    }

    const terminal = isPaddleTerminal(status);

    // (a) the provider row. On termination `is_default` is RELEASED, so the
    // single slot the partial unique index allows is free for whatever bills
    // this account next. A `paused` or `past_due` row KEEPS it: Paddle is
    // still this account's provider.
    const patch: Record<string, unknown> = {
      providerStatus: sub.status ?? null,
      renewsAt: dateOf(sub.next_billed_at),
      updatedAt: new Date(),
    };
    const base = sub.items?.[0];
    if (base?.price?.id) patch.providerPriceId = base.price.id;
    if (typeof base?.quantity === 'number') {
      patch.providerQuantity = base.quantity;
    }
    if (terminal) {
      patch.isDefault = false;
      patch.renewsAt = null;
      patch.endsAt = dateOf(sub.canceled_at) ?? new Date();
    } else if (sub.scheduled_change?.action === 'cancel') {
      // Cancelled but still running: record when it ends. Our own row's
      // `cancelAtPeriodEnd` is set below from the same scheduled change.
      patch.endsAt = dateOf(sub.scheduled_change.effective_at);
    }

    await db
      .update(providerSubscriptions)
      .set(patch)
      .where(eq(providerSubscriptions.id, target.rowId));

    // (b) our own subscription row.
    const mapped = mapPaddleStatus(sub.status, sub.scheduled_change);
    const subPatch: Record<string, unknown> = {
      status: mapped.status,
      cancelAtPeriodEnd: mapped.cancelAtPeriodEnd,
      updatedAt: new Date(),
    };
    const periodEnd = dateOf(sub.next_billed_at);
    if (periodEnd) subPatch.currentPeriodEnd = periodEnd;

    // The trial end, which `TrialEndingCron` is the only reader of.
    //
    // It filters on `subscriptions.trial_end` (`> now` and `<= now + 3
    // days`), so a Paddle subscription that never records one is invisible to
    // the sweep: no warning mail, then a charge. Nothing wrote this column on
    // the Paddle path at all until 2026-11-26.
    //
    // Written the same way as `currentPeriodEnd` just above — only when the
    // event actually carries a date. Paddle sends `trial_dates: null` on
    // every item once a trial is over, and `subscription.updated` fires for
    // reasons of its own, so clearing the column on an event that merely
    // omits it would erase the date before the sweep next ran: the same
    // outage by a different route.
    const trialEnd = trialEndOf(sub);
    if (trialEnd) subPatch.trialEnd = trialEnd;
    if (terminal) {
      subPatch.planCode = 'FREE';
      subPatch.cancelAtPeriodEnd = false;
      subPatch.scheduledPlanCode = null;
      subPatch.scheduledChangeAt = null;
      subPatch.canceledAt = new Date();
    }

    await db
      .update(subscriptions)
      .set(subPatch)
      .where(eq(subscriptions.id, target.subscriptionId));

    if (terminal) {
      await revokeBasePlan({
        provider: PROVIDER,
        subscriptionId: target.subscriptionId,
        limits: this.lookup,
      });

      // AFTER `revokeBasePlan`, never before. That call marks every Paddle
      // sibling row dead, so `rehomeDefault`'s liveness filter rejects them
      // all and only a genuinely live row at ANOTHER provider can inherit.
      // Running it first would hand the flag to a row this same call is about
      // to kill — and a cutover account whose Paddle plan lapses after the
      // customer moved elsewhere would otherwise be left with zero defaults
      // while something actively bills it.
      if (target.isDefault) {
        await rehomeDefault({
          subscriptionId: target.subscriptionId,
          excludeRowId: target.rowId,
        });
      }
      return;
    }

    // An add-on removed mid-period arrives here, as a `subscription.updated`
    // whose items no longer carry that price — Paddle fires no event of its
    // own for a line going away.
    await this.revokeMissingAddons(target, sub);
  }

  /**
   * Add-on rows whose price is no longer on the Paddle subscription.
   *
   * An add-on is a LINE here, not a subscription, so nothing fires when one
   * goes. Without this the `subscription_items` row survives and keeps
   * granting capacity nobody pays for — the entitlement mirror of billing
   * after a cancel.
   */
  private async revokeMissingAddons(
    target: Target,
    sub: PaddleSubscription,
  ): Promise<void> {
    const livePrices = new Set(
      (sub.items ?? [])
        .map((i) => i.price?.id)
        .filter((id): id is string => Boolean(id)),
    );
    // Nothing to compare against: an items array we did not receive must not
    // be read as "every add-on is gone".
    if (livePrices.size === 0) return;

    const rows = (await db
      .select({
        rowId: providerSubscriptions.id,
        itemType: providerSubscriptions.itemType,
        providerPriceId: providerSubscriptions.providerPriceId,
        providerStatus: providerSubscriptions.providerStatus,
      })
      .from(providerSubscriptions)
      .where(
        and(
          eq(providerSubscriptions.subscriptionId, target.subscriptionId),
          eq(providerSubscriptions.provider, PROVIDER),
        ),
      )) as {
      rowId: number;
      itemType: string;
      providerPriceId: string | null;
      providerStatus: string | null;
    }[];

    for (const row of rows) {
      if (row.itemType === 'BASE_PLAN') continue;
      // A row with no recorded price cannot be matched against the items, and
      // guessing would revoke a paid add-on.
      if (!row.providerPriceId) continue;
      if (livePrices.has(row.providerPriceId)) continue;
      // Already dead; its entitlements went with it.
      if (row.providerStatus === 'canceled') continue;

      await db
        .update(providerSubscriptions)
        .set({ providerStatus: 'canceled', updatedAt: new Date() })
        .where(eq(providerSubscriptions.id, row.rowId));

      await revokeAddon({
        subscriptionId: target.subscriptionId,
        itemType: row.itemType,
        limits: this.lookup,
      });

      this.logger.log(
        `Paddle add-on ${row.itemType} is no longer billed on subscription ` +
          `${target.subscriptionId}; entitlements revoked.`,
      );
    }
  }

  // -------------------------------------------------------------- payments

  /**
   * Payment events carry a TRANSACTION, so the provider subscription id is
   * `data.subscription_id` — `data.id` is the transaction's own id. Reading
   * `data.id` here would look a transaction id up in the subscription column
   * and silently match nothing.
   *
   * They carry no subscription status, so they never write the provider row's
   * status: `subscription.updated` follows and is the authority for that.
   * What they move is our own dunning state — a failure is `past_due`, a
   * completion is `active` again.
   */
  private async handleTransaction(
    eventType: string,
    txn: PaddleTransaction,
  ): Promise<void> {
    const paddleId = strOf(txn.subscription_id);
    if (!paddleId) {
      // A one-off transaction with no subscription. Nothing here concerns it.
      this.logger.log(`${eventType} carries no subscription_id; ignoring.`);
      return;
    }

    const target = await this.findTarget(paddleId);
    if (!target) {
      this.logger.warn(
        `No Paddle provider row for subscription ${paddleId} (${eventType}).`,
      );
      return;
    }

    const failed = eventType !== 'transaction.completed';
    const amountMinor = intOf(txn.details?.totals?.grand_total);
    // Keyed on the TRANSACTION, so a redelivery of the same event alerts once.
    // Paddle retries on any non-2xx, and `billing_payment_alerts` claims this
    // key atomically — without it a retry storm is an email storm.
    const alertKey = `${PROVIDER}:${failed ? 'failed' : 'recovered'}:${txn.id}`;

    // Dunning state only, and only on the base plan: an add-on line's failure
    // is the same subscription's failure.
    // Read BEFORE the write: `wasPastDue` is the recovery alert's evidence
    // that there was something to recover from, and the write below is what
    // destroys it.
    const account = await this.accountFor(target.subscriptionId);
    const wasPastDue = account?.status === 'past_due';

    if (target.itemType === 'BASE_PLAN') {
      await db
        .update(subscriptions)
        .set({
          status: failed ? 'past_due' : 'active',
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.id, target.subscriptionId));
    }

    if (!account) return;

    try {
      if (failed) {
        await this.paymentAlerts.paymentFailed({
          userId: account.userId,
          provider: PROVIDER,
          alertKey,
          amountMinor,
          // Paddle does not put the declined card in the payload, so the
          // alert falls back to the account's saved default rather than
          // naming a card we are guessing at.
          card: null,
          reason: null,
        });
        await this.emailPaymentFailed(account, amountMinor, alertKey);
      } else {
        await this.paymentAlerts.paymentSucceeded({
          userId: account.userId,
          provider: PROVIDER,
          alertKey,
          amountMinor,
          planCode: account.planCode,
          wasPastDue,
        });
      }
    } catch (error) {
      // The webhook must answer 200 whatever happens to an alert: a 500 here
      // is a Paddle retry of an event already applied.
      this.logger.warn(
        `Paddle payment alert (${eventType}) skipped: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * The payment-failed EMAIL, which is separate from the in-app alert above
   * and mandatory.
   *
   * `payment-alerts.service` says so in its own words: "The payment-failed
   * EMAIL is mandatory and sent by the webhooks, not here." The alert rings a
   * bell and raises a toast, and both are conditional on the user's
   * `billing_alert` preference; the email is not, because a customer whose
   * card declined has to find out even when they are not logged in — which is
   * the normal case during a dunning retry window.
   *
   * Without this a Paddle customer's card could fail, Paddle could exhaust its
   * retries, and the subscription could end with the account silently dropping
   * to FREE, having been told nothing. Stripe and Lemon Squeezy both send it;
   * Paddle did not.
   *
   * Failures are swallowed for the same reason the alert's are: the webhook
   * must answer 200, or Paddle retries an event already applied.
   */
  private async emailPaymentFailed(
    // `planCode` is nullable on the row this comes from; the email names the
    // plan, so an unknown one falls back rather than blocking the send.
    account: { userId: string; planCode: string | null },
    // Null when Paddle's payload omits the total; the email prints the
    // amount, so an unknown one shows as zero rather than suppressing a
    // notice the customer needs.
    amountMinor: number | null,
    alertKey: string,
  ): Promise<void> {
    try {
      await this.billingEmail.paymentFailed({
        userId: account.userId,
        planName: await this.billingEmail.planName(account.planCode ?? 'FREE'),
        amountCents: amountMinor ?? 0,
        currency: 'usd',
        // Paddle's payload carries no card details on a failure, so naming a
        // card here would be a guess. The template falls back to the saved
        // default rather than printing nothing.
        cardLast4: null,
        cardBrand: null,
        reason: null,
        nextAttempt: null,
        dedupeKey: billingEmailKey('payment-failed', PROVIDER, alertKey, 0),
      });
    } catch (error) {
      this.logger.warn(
        `Billing email (payment failed) skipped: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ---------------------------------------------------------------- helpers

  private async findTarget(paddleId: string): Promise<Target | null> {
    const rows = (await db
      .select({
        rowId: providerSubscriptions.id,
        subscriptionId: providerSubscriptions.subscriptionId,
        itemType: providerSubscriptions.itemType,
        isDefault: providerSubscriptions.isDefault,
        providerStatus: providerSubscriptions.providerStatus,
      })
      .from(providerSubscriptions)
      .where(
        and(
          eq(providerSubscriptions.provider, PROVIDER),
          eq(providerSubscriptions.providerSubscriptionId, paddleId),
          eq(providerSubscriptions.itemType, 'BASE_PLAN'),
        ),
      )) as Target[];

    return rows[0] ?? null;
  }

  /** The billing owner, and the dunning state an alert needs. */
  private async accountFor(subscriptionId: number): Promise<{
    userId: string;
    status: string | null;
    planCode: string | null;
  } | null> {
    const rows = (await db
      .select({
        userId: subscriptions.userId,
        status: subscriptions.status,
        planCode: subscriptions.planCode,
      })
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))) as {
      userId: string;
      status: string | null;
      planCode: string | null;
    }[];

    return rows[0] ?? null;
  }
}

/**
 * A string id, or null.
 *
 * Narrowed to primitives on purpose: a bare `String(value)` turns an object
 * into the literal `'[object Object]'`, which would then be written into
 * `provider_subscription_id` and looked up by later webhooks as a real id — a
 * lookup that silently matches nothing, or collides with another account that
 * suffered the same coercion.
 */
function strOf(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Paddle sends money as a STRING of minor units ("2900" is $29.00). Its own
 * doc: "Although represented as a string, this value must be a valid integer."
 */
function intOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * The latest trial end across a Paddle subscription's items.
 *
 * Paddle carries trial dates PER ITEM (`items[].trial_dates.ends_at`), with
 * no top-level field, and an item without a trial has `trial_dates: null`.
 * The base plan is not guaranteed to be `items[0]` — an add-on bought during
 * the trial can come first — so every item is scanned rather than trusting
 * position the way the price and quantity reads above do. Those two are a
 * best-effort refresh of a column; this one decides whether a customer is
 * warned before being charged, so the cost of reading the wrong item is not
 * the same.
 *
 * The LATEST end is taken when more than one item carries a trial: the
 * account is still trialling until the last of them expires, and warning on
 * the earliest would send the mail while the trial still has days to run.
 */
function trialEndOf(sub: PaddleSubscription): Date | null {
  let latest: Date | null = null;
  for (const item of sub.items ?? []) {
    const ends = dateOf(item.trial_dates?.ends_at);
    if (ends && (!latest || ends.getTime() > latest.getTime())) latest = ends;
  }
  return latest;
}

function dateOf(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
