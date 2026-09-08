import { InternalServerErrorException } from '@nestjs/common';
import { PaymentProvider } from '../drizzle/schema';

/**
 * Refuse a Stripe call aimed at a subscription Stripe does not bill.
 *
 * This exists because the failure mode is SILENCE. Today every one of the 39
 * Stripe call sites runs unconditionally; a Stripe call on a Lemon Squeezy
 * customer does not throw, it succeeds — charging the wrong place or writing
 * the wrong id — and is found weeks later as a billing discrepancy.
 *
 * Throwing turns that into an immediate, traceable 500, usually in testing.
 *
 * A null provider is ALLOWED: a subscription with no provider rows is
 * mid-creation, and that is precisely the Stripe signup path which creates the
 * first row. Blocking it would break the flow this guard protects.
 */
export function assertProviderIsStripe(
  provider: PaymentProvider | null,
  subscriptionId: number,
): void {
  if (provider && provider !== 'stripe') {
    throw new InternalServerErrorException(
      `Stripe call attempted for subscription ${subscriptionId}, which is ` +
        `billed by ${provider}. This is a provider-routing bug.`,
    );
  }
}
