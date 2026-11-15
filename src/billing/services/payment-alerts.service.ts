import { Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { notifications, plans } from '../../drizzle/schema';
import { NotificationEmitterService } from '../../notifications/notification-emitter.service';
import { AnalyticsEventEmitter } from '../../realtime/analytics-event-emitter.service';
import type { BillingPaymentCard } from '../../realtime/types/user-events.types';
import { PaymentMethodService } from './payment-method.service';
import { SubscriptionLookupService } from './subscription-lookup.service';

export type PaymentProvider = 'stripe' | 'lemonsqueezy';

export interface PaymentFailedInput {
  /** The billing owner: `subscriptions.user_id`. */
  userId: string;
  provider: PaymentProvider;
  /**
   * Identifies ONE failed attempt (provider + invoice + attempt). The same key
   * never notifies twice, so a redelivered webhook is a no-op here.
   */
  dedupeKey: string;
  /** Amount that failed, in minor units (cents). */
  amountMinor: number | null;
  /**
   * The declined card when the webhook names it (Lemon Squeezy does). Null
   * falls back to the account's saved default card (Stripe).
   */
  card: BillingPaymentCard | null;
  reason: string | null;
}

export interface PaymentSucceededInput {
  userId: string;
  provider: PaymentProvider;
  amountMinor: number | null;
  planCode: string | null;
  /**
   * The caller's own evidence of dunning, read before its writes (status was
   * `past_due`, or unresolved failure rows existed).
   */
  wasPastDue: boolean;
}

/**
 * Tells the billing owner that a payment failed, and that it recovered.
 *
 * Two channels, each with one job:
 * - a `payment_failed` / `payment_successful` NOTIFICATION row: the record in
 *   the bell, routed to the owner's workspace billing page;
 * - a `billing.payment.changed` event on `/realtime` to the owner's own room:
 *   the live signal that opens the "Payment failed" toast, and closes it (and
 *   the banner) on recovery without a reload.
 *
 * Never throws. Both webhook services call this AFTER their billing writes;
 * an alert that fails must not fail the webhook — the provider would redeliver
 * and every write before it would run again.
 */
@Injectable()
export class PaymentAlertsService {
  private readonly logger = new Logger(PaymentAlertsService.name);

  constructor(
    private readonly notifier: NotificationEmitterService,
    private readonly realtime: AnalyticsEventEmitter,
    private readonly lookup: SubscriptionLookupService,
    private readonly paymentMethods: PaymentMethodService,
  ) {}

  /** Returns true when an alert went out, false when deduped or it failed. */
  async paymentFailed(input: PaymentFailedInput): Promise<boolean> {
    try {
      if (await this.alreadyNotified(input.userId, input.dedupeKey)) {
        this.logger.log(
          `Payment failure ${input.dedupeKey} already notified; skipping.`,
        );
        return false;
      }

      const workspaceId = await this.lookup.getPrimaryWorkspaceId(input.userId);
      const card = input.card ?? (await this.savedCard(input.userId));

      await this.notifier.paymentFailed(
        input.userId,
        toMajor(input.amountMinor),
        cleanReason(input.reason),
        {
          actionUrl: billingUrl(workspaceId),
          metadata: {
            dedupeKey: input.dedupeKey,
            provider: input.provider,
            workspaceId,
            card,
          },
        },
      );

      this.realtime.emitToUser(input.userId, 'billing.payment.changed', {
        state: 'failed',
        provider: input.provider,
        workspaceId,
        card,
        occurredAt: new Date().toISOString(),
      });
      return true;
    } catch (err) {
      this.logger.error(
        `Could not alert user ${input.userId} about payment failure ` +
          `${input.dedupeKey}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /**
   * A payment went through. Announced only when it ENDS a failure — ordinary
   * renewals succeed every month and must stay silent.
   *
   * It is a recovery when the caller saw dunning (`wasPastDue`) OR the
   * owner's latest billing alert is still a failure. The second check exists
   * because providers do not order their events: the subscription-status
   * event can land first and flip the account to `active` before the payment
   * event arrives, and `wasPastDue` alone would then miss the recovery.
   * Redelivery stays silent: once announced, the latest alert is the recovery
   * and the account is `active`.
   */
  async paymentSucceeded(input: PaymentSucceededInput): Promise<boolean> {
    try {
      if (!input.wasPastDue && !(await this.latestAlertIsFailure(input.userId)))
        return false;

      const workspaceId = await this.lookup.getPrimaryWorkspaceId(input.userId);
      await this.notifier.paymentSuccessful(
        input.userId,
        toMajor(input.amountMinor),
        await this.planName(input.planCode),
        {
          actionUrl: billingUrl(workspaceId),
          metadata: {
            kind: 'payment_recovered',
            provider: input.provider,
            workspaceId,
          },
        },
      );

      this.realtime.emitToUser(input.userId, 'billing.payment.changed', {
        state: 'recovered',
        provider: input.provider,
        workspaceId,
        card: null,
        occurredAt: new Date().toISOString(),
      });
      return true;
    } catch (err) {
      this.logger.error(
        `Could not alert user ${input.userId} about payment recovery: ` +
          `${(err as Error).message}`,
      );
      return false;
    }
  }

  private async alreadyNotified(
    userId: string,
    dedupeKey: string,
  ): Promise<boolean> {
    const rows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          eq(notifications.type, 'payment_failed'),
          sql`${notifications.metadata}->>'dedupeKey' = ${dedupeKey}`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  private async latestAlertIsFailure(userId: string): Promise<boolean> {
    const rows = await db
      .select({ type: notifications.type })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          inArray(notifications.type, ['payment_failed', 'payment_successful']),
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(1);
    return rows[0]?.type === 'payment_failed';
  }

  private async savedCard(userId: string): Promise<BillingPaymentCard | null> {
    const method = await this.paymentMethods.getDefaultPaymentMethod(userId);
    return toCard(method?.brand, method?.last4);
  }

  private async planName(planCode: string | null): Promise<string> {
    if (!planCode) return 'your plan';
    const rows = await db
      .select({ name: plans.name })
      .from(plans)
      .where(eq(plans.code, planCode))
      .limit(1);
    return rows[0]?.name ?? planCode;
  }
}

/** A card only when both halves are present; half a card names nothing. */
export function toCard(
  brand: string | null | undefined,
  last4: string | null | undefined,
): BillingPaymentCard | null {
  const b = typeof brand === 'string' ? brand.trim().toLowerCase() : '';
  const l = typeof last4 === 'string' ? last4.trim() : '';
  if (!b || !/^\d{4}$/.test(l)) return null;
  return { brand: b, last4: l };
}

/** The frontend routes billing under a workspace: `/w/:id/settings/billing`. */
function billingUrl(workspaceId: string | null): string | undefined {
  return workspaceId ? `/w/${workspaceId}/settings/billing` : undefined;
}

function toMajor(amountMinor: number | null): number {
  return typeof amountMinor === 'number' && Number.isFinite(amountMinor)
    ? amountMinor / 100
    : 0;
}

/** The emitter appends its own full stop; a reason ending in one doubled it. */
function cleanReason(reason: string | null): string | undefined {
  const trimmed = reason?.trim().replace(/[.\s]+$/, '');
  return trimmed ? trimmed : undefined;
}
