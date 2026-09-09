import { Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { StripeService } from '../../stripe/stripe.service';

const logger = new Logger('StripeImmediateInvoice');

/** Stripe attaches a `code` to its errors; anything else is not one of ours. */
function describeStripeError(err: unknown): {
  code?: string;
  message: string;
} {
  if (typeof err === 'object' && err !== null) {
    const e = err as { code?: string; message?: string };
    return { code: e.code, message: e.message ?? 'unknown Stripe error' };
  }
  return { message: String(err) };
}

/**
 * Create and pay an invoice for any pending proration charges, right now —
 * the industry-standard behaviour when a customer upgrades mid-cycle.
 *
 * Stripe-only, and deliberately NOT an abstracted operation. Lemon Squeezy has
 * no equivalent to reach for: it invoices a plan change itself, via the
 * `invoice_immediately` attribute on the subscription PATCH that
 * `LemonSqueezyAdapter.changePlan` already sends. Calling this for a Lemon
 * Squeezy account would look up a Stripe subscription id that provider never
 * issued, so the caller gates on the resolved adapter being Stripe.
 *
 * Lives inside the provider boundary so the service layer holds no Stripe
 * calls and a future feature cannot quietly reintroduce one.
 */
export async function invoiceStripeProrationsImmediately(
  stripeService: StripeService,
  stripeSubscriptionId: string,
): Promise<void> {
  try {
    const stripe = stripeService.getClient();

    // Get the subscription to find the customer ID and payment method
    const subscription = await stripe.subscriptions.retrieve(
      stripeSubscriptionId,
      { expand: ['default_payment_method'] },
    );
    const customerId =
      typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer.id;

    const paymentMethodId =
      typeof subscription.default_payment_method === 'string'
        ? subscription.default_payment_method
        : subscription.default_payment_method?.id;

    // Create an invoice for any pending invoice items (prorations)
    const invoice = await stripe.invoices.create({
      customer: customerId,
      subscription: stripeSubscriptionId,
      auto_advance: true,
    });

    if (invoice.amount_due > 0) {
      const payParams: Stripe.InvoicePayParams = {};
      if (paymentMethodId) {
        payParams.payment_method = paymentMethodId;
      }
      await stripe.invoices.pay(invoice.id, payParams);
      logger.log(
        `Immediately charged ${invoice.amount_due} cents for plan upgrade`,
      );
    } else if (invoice.status === 'draft') {
      // Finalize even if $0 (for record keeping)
      await stripe.invoices.finalizeInvoice(invoice.id);
    }
  } catch (error: unknown) {
    const { code, message } = describeStripeError(error);
    // If there are no pending items to invoice, that is a no-op, not a failure.
    if (code === 'invoice_no_subscription_line_items') {
      return;
    }
    logger.error(`Failed to create immediate invoice: ${message}`);
    throw error;
  }
}
