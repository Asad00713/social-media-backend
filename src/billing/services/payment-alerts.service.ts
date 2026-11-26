import { Injectable, Logger } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import {
  billingPaymentAlerts,
  plans,
  type BillingPaymentAlertKind,
} from '../../drizzle/schema';
import { NotificationPreferencesService } from '../../notification-preferences/notification-preferences.service';
import { NotificationEmitterService } from '../../notifications/notification-emitter.service';
import { AnalyticsEventEmitter } from '../../realtime/analytics-event-emitter.service';
import type { BillingPaymentCard } from '../../realtime/types/user-events.types';
import { PaymentMethodService } from './payment-method.service';
import { SubscriptionLookupService } from './subscription-lookup.service';

/**
 * Re-exported, not redeclared. This file had its own copy of the union, which
 * is how three places came to disagree about which providers exist the moment
 * a third one was added. Imported as well as re-exported, because a bare
 * `export type { ... } from` does not bring the name into this file's scope.
 */
import type { PaymentProvider } from '../../drizzle/schema';
export type { PaymentProvider };

export interface PaymentFailedInput {
  /** The billing owner: `subscriptions.user_id`. */
  userId: string;
  provider: PaymentProvider;
  /**
   * Identifies ONE failure (Stripe: the event id; Lemon Squeezy: invoice +
   * `updated_at`). Claimed atomically in `billing_payment_alerts`, so the
   * same key never alerts twice, however often or concurrently it arrives.
   */
  alertKey: string;
  /** Amount that failed, in minor units (cents). */
  amountMinor: number | null;
  /**
   * The declined card when the webhook names it (Lemon Squeezy does). Null
   * falls back to the account's saved default card (Stripe).
   */
  card: BillingPaymentCard | null;
  /** The provider's decline message, when it sent one. */
  reason: string | null;
}

export interface PaymentSucceededInput {
  userId: string;
  provider: PaymentProvider;
  /**
   * Identifies the payment (provider + invoice). Lemon Squeezy sends
   * `subscription_payment_success` AND `subscription_payment_recovered` for
   * one invoice; both carry the same key, so only one recovery goes out.
   */
  alertKey: string;
  amountMinor: number | null;
  planCode: string | null;
  /**
   * The caller's own evidence of dunning, decided atomically with its write
   * (the account moved from `past_due`, or unresolved failure rows existed).
   */
  wasPastDue: boolean;
}

/**
 * Tells the billing owner that a payment failed, and that it recovered.
 *
 * Two channels, each with one job:
 * - a `payment_failed` / `payment_successful` NOTIFICATION row: the record in
 *   the bell, routed to the owner's own billing page;
 * - a `billing.payment.changed` event on `/realtime` to the owner's own room:
 *   the live signal that opens the "Payment failed" toast, and closes it (and
 *   the banner) on recovery without a reload.
 *
 * Whether an alert already went out lives in `billing_payment_alerts`
 * (billing data, unique `alert_key`), never in `notifications`: a user can
 * delete notifications, and "clear all" must not re-arm an alert.
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
    private readonly prefs: NotificationPreferencesService,
  ) {}

  /**
   * Returns true when an alert went out; false when deduped, switched off or
   * it failed. The bell and the toast follow the owner's in-app
   * `billing_alert` switch for the workspace the bell links to (account level
   * without one). Off keeps the claim: the failure stays on record, so a
   * redelivery stays quiet and a later recovery is still recognised. The
   * payment-failed EMAIL is mandatory and sent by the webhooks, not here.
   */
  async paymentFailed(input: PaymentFailedInput): Promise<boolean> {
    let claimId: number | null = null;
    try {
      claimId = await this.claim(input, 'failed');
      if (claimId === null) {
        this.logger.log(`Payment alert ${input.alertKey} already sent.`);
        return false;
      }

      const workspaceId = await this.lookup.getPrimaryWorkspaceId(input.userId);
      const wanted = await this.prefs.shouldSend(
        input.userId,
        workspaceId,
        'billing_alert',
        'app',
      );
      if (!wanted) {
        this.logger.log(
          `Payment alert ${input.alertKey}: in-app billing alerts are off for user ${input.userId}.`,
        );
        return false;
      }
      const card = input.card ?? (await this.savedCard(input.userId));

      await this.notifier.paymentFailed(
        input.userId,
        toMajor(input.amountMinor),
        cleanReason(input.reason),
        {
          actionUrl: billingUrl(workspaceId),
          metadata: {
            alertKey: input.alertKey,
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
      await this.release(claimId);
      this.logger.error(
        `Could not alert user ${input.userId} about payment failure ` +
          `${input.alertKey}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /**
   * A payment went through. Announced only when it ENDS a failure — ordinary
   * renewals succeed every month and must stay silent.
   *
   * It is a recovery when the caller saw dunning (`wasPastDue`) OR the
   * owner's latest alert is still a failure. The second check exists because
   * providers do not order their events: the subscription-status event can
   * land first and flip the account to `active` before the payment event
   * arrives, and `wasPastDue` alone would then miss the recovery. The claim on
   * `alertKey` makes it once-only even when two events race through here.
   */
  async paymentSucceeded(input: PaymentSucceededInput): Promise<boolean> {
    let claimId: number | null = null;
    try {
      if (!input.wasPastDue && !(await this.latestAlertIsFailure(input.userId)))
        return false;

      claimId = await this.claim(input, 'recovered');
      if (claimId === null) return false;

      const workspaceId = await this.lookup.getPrimaryWorkspaceId(input.userId);
      await this.notifier.paymentSuccessful(
        input.userId,
        toMajor(input.amountMinor),
        await this.planName(input.planCode),
        {
          actionUrl: billingUrl(workspaceId),
          metadata: {
            kind: 'payment_recovered',
            alertKey: input.alertKey,
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
      await this.release(claimId);
      this.logger.error(
        `Could not alert user ${input.userId} about payment recovery ` +
          `${input.alertKey}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Atomic "first one wins": the unique `alert_key` makes a concurrent or
   * redelivered claim insert nothing. Returns the new row's id, or null.
   */
  private async claim(
    input: { userId: string; provider: PaymentProvider; alertKey: string },
    kind: BillingPaymentAlertKind,
  ): Promise<number | null> {
    const rows = await db
      .insert(billingPaymentAlerts)
      .values({
        userId: input.userId,
        alertKey: input.alertKey,
        kind,
        provider: input.provider,
      })
      .onConflictDoNothing({ target: billingPaymentAlerts.alertKey })
      .returning({ id: billingPaymentAlerts.id });
    return rows[0]?.id ?? null;
  }

  /**
   * The alert could not be sent: give the key back so a later delivery of the
   * same event can try again, rather than leaving a claim nobody was told of.
   */
  private async release(claimId: number | null): Promise<void> {
    if (claimId === null) return;
    try {
      await db
        .delete(billingPaymentAlerts)
        .where(eq(billingPaymentAlerts.id, claimId));
    } catch (err) {
      this.logger.error(
        `Could not release payment alert claim ${claimId}: ${(err as Error).message}`,
      );
    }
  }

  private async latestAlertIsFailure(userId: string): Promise<boolean> {
    const rows = await db
      .select({ kind: billingPaymentAlerts.kind })
      .from(billingPaymentAlerts)
      .where(eq(billingPaymentAlerts.userId, userId))
      .orderBy(
        desc(billingPaymentAlerts.createdAt),
        desc(billingPaymentAlerts.id),
      )
      .limit(1);
    return rows[0]?.kind === 'failed';
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

/**
 * Where the owner fixes billing. The frontend routes billing under a workspace
 * (`/w/:id/settings/billing`); an owner with no workspace of their own goes to
 * their workspaces hub, never into a workspace someone else owns.
 */
export const NO_WORKSPACE_BILLING_URL = '/workspaces';

function billingUrl(workspaceId: string | null): string {
  return workspaceId
    ? `/w/${workspaceId}/settings/billing`
    : NO_WORKSPACE_BILLING_URL;
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
