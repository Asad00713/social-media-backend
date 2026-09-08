import { BadRequestException, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { subscriptions } from '../../drizzle/schema';
import { StripeService } from '../../stripe/stripe.service';

const logger = new Logger('StripeStaleSubscription');

/** Stripe attaches a `code` to its errors; anything else is not one of ours. */
function stripeErrorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? (err as { code?: string }).code
    : undefined;
}

/**
 * Stripe-only recovery for a `stripe_subscription_id` that no longer exists
 * on Stripe (test data wiped, account swapped, test/live mode switched).
 *
 * Not an abstracted operation: it inspects a Stripe error CODE
 * (`resource_missing`) and clears a Stripe-named column. It lives inside the
 * provider boundary so the service layer holds no Stripe calls, and it is
 * called only after the registry has confirmed the account bills through
 * Stripe — running it on a Lemon Squeezy account would look up an id Stripe
 * never issued.
 *
 * Turns a generic 500 mid-mutation into an actionable "re-subscribe" message,
 * which is why it runs BEFORE the add-on call rather than after it fails.
 */
export async function clearStaleStripeSubscription(
  stripe: StripeService,
  sub: { id: number; stripeSubscriptionId: string | null },
  contextLabel: string,
): Promise<boolean> {
  if (!sub.stripeSubscriptionId) return false;

  try {
    await stripe.getSubscription(sub.stripeSubscriptionId);
    return false;
  } catch (err: unknown) {
    // Only `resource_missing` means "this id is gone". Anything else (a
    // network blip, an auth failure) must propagate - swallowing it would
    // silently null out a LIVE subscription id and orphan a paying customer.
    if (stripeErrorCode(err) !== 'resource_missing') throw err;

    logger.warn(
      `Stale stripe_subscription_id ${sub.stripeSubscriptionId} for ${contextLabel} - clearing and asking user to re-subscribe.`,
    );

    // Clear the orphan reference so the next subscribe call creates fresh.
    await db
      .update(subscriptions)
      .set({
        stripeSubscriptionId: null,
        status: 'incomplete',
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, sub.id));

    return true;
  }
}

/**
 * The `clearStaleStripeSubscription` variant that REFUSES rather than
 * recovering, for callers with nowhere to fall back to (an add-on purchase
 * cannot proceed without a subscription to attach it to).
 */
export async function assertStripeSubscriptionExists(
  stripe: StripeService,
  sub: { id: number; stripeSubscriptionId: string | null },
  contextLabel: string,
): Promise<void> {
  const wasStale = await clearStaleStripeSubscription(
    stripe,
    sub,
    contextLabel,
  );
  if (wasStale) {
    throw new BadRequestException(
      'Your subscription is no longer linked to Stripe (this can happen if test data was reset or the Stripe account changed). Please go to Billing and re-subscribe to your current plan, then try adding the add-on again.',
    );
  }
}
