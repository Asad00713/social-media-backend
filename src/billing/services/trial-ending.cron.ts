import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, eq, gt, inArray, lte } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import {
  providerSubscriptions,
  subscriptions,
  type PaymentProvider,
} from '../../drizzle/schema/billing.schema';
import { BillingEmailService } from './billing-email.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The providers whose trials this sweep is responsible for.
 *
 * Stripe is NOT here, and that is not an oversight: it fires
 * `customer.subscription.trial_will_end` of its own, which
 * `stripe/webhook.service.ts` already turns into the same mail. Listing it
 * would send a second copy.
 *
 * Both of the others are Merchants of Record that send no such event, so the
 * sweep is the only thing that warns their customers. The list is explicit
 * rather than "every provider except Stripe" so that a provider added to
 * `PAYMENT_PROVIDERS` cannot silently inherit a mail it may duplicate — but
 * it is a LIST, not a single value, because it was one, and a Paddle trial
 * therefore went unwarned until the customer was charged.
 */
const SWEPT_PROVIDERS: PaymentProvider[] = ['lemonsqueezy', 'paddle'];

/**
 * Lemon Squeezy and Paddle send no "trial will end" event (Stripe does), so a
 * daily sweep finds the trials that end within three days: a trial end in
 * `(now, now + 3 days]`. The upper bound keeps the mail from going out
 * earlier than three days before. The lower bound is just "not over yet", so
 * a missed run is made up the next day instead of losing the trial.
 * `BillingEmailService.trialEnding` claims each trial for a week, so the
 * daily overlap, a second run or a second instance sends nothing more.
 * A trial that is set to cancel is skipped: its owner already chose to leave.
 *
 * `ScheduleModule.forRoot()` is registered in AppModule.
 */
@Injectable()
export class TrialEndingCron {
  private readonly logger = new Logger(TrialEndingCron.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly billingEmail: BillingEmailService,
  ) {}

  @Cron('0 9 * * *', { timeZone: 'UTC', name: 'lsTrialEnding' })
  async nightly(): Promise<void> {
    await this.sendDue();
  }

  /** Returns how many trials were handed to the email service. */
  async sendDue(now: Date = new Date()): Promise<number> {
    // Two queries, not a join, because the join MULTIPLIES. One subscription
    // can hold a BASE_PLAN row at more than one provider — a cutover account
    // keeps the row at the provider it left — and an inner join then yields
    // that account once PER provider row, so the same customer is handed to
    // the email service twice. The claim inside `trialEnding` happens to
    // swallow the duplicate today, which is exactly why a join would look
    // fine here and be one claim change away from mailing twice.
    //
    // The TRIALS are asked for first and the provider check narrows them,
    // rather than the other way round: the window is a handful of rows on any
    // account base, while "every BASE_PLAN row at a Merchant of Record" grows
    // with the whole customer list.
    const candidates = await this.db
      .select({
        id: subscriptions.id,
        userId: subscriptions.userId,
        planCode: subscriptions.planCode,
        trialEnd: subscriptions.trialEnd,
      })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.status, 'trialing'),
          eq(subscriptions.cancelAtPeriodEnd, false),
          gt(subscriptions.trialEnd, now),
          lte(subscriptions.trialEnd, new Date(now.getTime() + 3 * DAY_MS)),
        ),
      );

    if (candidates.length === 0) return 0;

    // Which of them a swept provider bills the PLAN for. A Set, so an account
    // mid-cutover — one holding a BASE_PLAN row at two of these providers —
    // is a single member and is mailed once.
    const swept = await this.db
      .select({ subscriptionId: providerSubscriptions.subscriptionId })
      .from(providerSubscriptions)
      .where(
        and(
          inArray(
            providerSubscriptions.subscriptionId,
            candidates.map((row) => row.id),
          ),
          inArray(providerSubscriptions.provider, SWEPT_PROVIDERS),
          eq(providerSubscriptions.itemType, 'BASE_PLAN'),
        ),
      );

    const sweptIds = new Set(swept.map((row) => row.subscriptionId));
    const rows = candidates.filter((row) => sweptIds.has(row.id));

    let handled = 0;
    for (const row of rows) {
      if (!row.trialEnd) continue;
      try {
        await this.billingEmail.trialEnding({
          userId: row.userId,
          subscriptionId: row.id,
          trialEnd: row.trialEnd,
          planCode: row.planCode,
          // Neither Merchant of Record tells us whether a card is still on
          // file — both take one at checkout — so the mail promises nothing
          // either way.
          hasCard: null,
        });
        handled += 1;
      } catch (error) {
        // One account's failure must not stop the others.
        this.logger.warn(
          `Trial-ending sweep skipped subscription ${row.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return handled;
  }
}
