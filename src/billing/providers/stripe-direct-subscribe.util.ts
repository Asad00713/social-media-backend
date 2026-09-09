import { BadRequestException } from '@nestjs/common';
import Stripe from 'stripe';
import { StripeService } from '../../stripe/stripe.service';

/**
 * The Stripe-only half of the legacy "subscribe with a card already on file"
 * path (`SubscriptionService.createSubscription`).
 *
 * This is NOT one of the eight abstracted operations, and it cannot become
 * one: it takes a raw Stripe `paymentMethodId` and creates a subscription
 * server-side, which Lemon Squeezy has no endpoint for — a subscription can
 * only begin at a hosted checkout there. So rather than pretend it is
 * provider-neutral, it lives here, inside the provider boundary, where the
 * isolation test expects Stripe to be named.
 *
 * The caller resolves the account's provider FIRST and refuses non-Stripe
 * accounts before calling this. Keeping the Stripe calls in one place means a
 * later feature cannot reach for `stripeService` from the service layer and
 * quietly reintroduce the unconditional-Stripe bug.
 */
export async function createStripeSubscriptionDirect(
  stripe: StripeService,
  input: {
    stripeCustomerId: string;
    stripePriceId: string;
    paymentMethodId?: string;
    metadata: Record<string, string>;
    trialPeriodDays?: number;
  },
): Promise<Stripe.Subscription> {
  if (input.paymentMethodId) {
    await stripe.attachPaymentMethod(
      input.paymentMethodId,
      input.stripeCustomerId,
    );
    await stripe.setDefaultPaymentMethod(
      input.stripeCustomerId,
      input.paymentMethodId,
    );
  } else {
    // A paid subscription must have a card. FREE→paid goes through Checkout;
    // this direct path must never create an incomplete subscription.
    const hasCard = await stripe.customerHasPaymentMethod(
      input.stripeCustomerId,
    );
    if (!hasCard) {
      throw new BadRequestException(
        'A payment method is required for a paid plan — subscribe via Checkout',
      );
    }
  }

  return await stripe.createSubscription({
    customerId: input.stripeCustomerId,
    priceId: input.stripePriceId,
    metadata: input.metadata,
    trialPeriodDays: input.trialPeriodDays,
  });
}
