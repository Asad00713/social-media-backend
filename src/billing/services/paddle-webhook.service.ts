import { Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import {
  providerSubscriptions,
  subscriptions,
} from '../../drizzle/schema';
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

function dateOf(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
