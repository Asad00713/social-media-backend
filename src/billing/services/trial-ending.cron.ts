import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, eq, gt, lte } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import {
  providerSubscriptions,
  subscriptions,
} from '../../drizzle/schema/billing.schema';
import { BillingEmailService } from './billing-email.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Lemon Squeezy sends no "trial will end" event (Stripe does), so a daily
 * sweep finds the trials that end in about three days: those with a trial end
 * in `(now + 2 days, now + 3 days]`, which a once-a-day run visits exactly
 * once. `BillingEmailService.trialEnding` claims each trial for a week, so a
 * second run or a second instance sends nothing more.
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
    const rows = await this.db
      .select({
        id: subscriptions.id,
        userId: subscriptions.userId,
        planCode: subscriptions.planCode,
        trialEnd: subscriptions.trialEnd,
      })
      .from(subscriptions)
      .innerJoin(
        providerSubscriptions,
        and(
          eq(providerSubscriptions.subscriptionId, subscriptions.id),
          eq(providerSubscriptions.provider, 'lemonsqueezy'),
          eq(providerSubscriptions.itemType, 'BASE_PLAN'),
        ),
      )
      .where(
        and(
          eq(subscriptions.status, 'trialing'),
          gt(subscriptions.trialEnd, new Date(now.getTime() + 2 * DAY_MS)),
          lte(subscriptions.trialEnd, new Date(now.getTime() + 3 * DAY_MS)),
        ),
      );

    let handled = 0;
    for (const row of rows) {
      if (!row.trialEnd) continue;
      try {
        await this.billingEmail.trialEnding({
          userId: row.userId,
          subscriptionId: row.id,
          trialEnd: row.trialEnd,
          planCode: row.planCode,
          // Lemon Squeezy takes the card at checkout and does not say whether
          // one is still on file, so the mail promises nothing either way.
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
