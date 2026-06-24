import { config } from 'dotenv';
config({ path: '.env' });

import Stripe from 'stripe';
import { and, isNotNull, ne } from 'drizzle-orm';
import { db } from '../db';
import { subscriptions } from '../schema';
import { upsertInvoiceFromStripe } from '../../billing/services/invoice-sync.util';

/**
 * One-off backfill: pull every invoice Stripe has for our non-FREE subscriptions
 * and upsert them into our DB. Needed because earlier checkouts ran before the
 * webhook/raw-body + Clover API-shape fixes, so their invoices were never
 * persisted. Idempotent — safe to re-run (upsert keyed on stripe_invoice_id).
 */
async function backfill() {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) {
    throw new Error('STRIPE_SECRET_KEY is not defined');
  }

  const stripe = new Stripe(apiKey, { apiVersion: '2025-12-15.clover' });
  const mode = apiKey.startsWith('sk_live') ? 'LIVE' : 'TEST';

  console.log('==========================================');
  console.log(`Invoice backfill — mode: ${mode}`);
  console.log('==========================================');

  const subs = await db
    .select({
      id: subscriptions.id,
      workspaceId: subscriptions.workspaceId,
      planCode: subscriptions.planCode,
      stripeSubscriptionId: subscriptions.stripeSubscriptionId,
    })
    .from(subscriptions)
    .where(
      and(
        isNotNull(subscriptions.stripeSubscriptionId),
        ne(subscriptions.planCode, 'FREE'),
      ),
    );

  if (subs.length === 0) {
    console.log('No paid subscriptions with a Stripe id found. Nothing to do.');
    return;
  }

  let invoiceCount = 0;
  for (const sub of subs) {
    const stripeSubId = sub.stripeSubscriptionId as string;
    console.log(
      `\nSubscription db#${sub.id} (${sub.planCode}) → Stripe ${stripeSubId}`,
    );

    const list = await stripe.invoices.list({
      subscription: stripeSubId,
      limit: 100,
    });

    if (list.data.length === 0) {
      console.log('  (no invoices on Stripe)');
      continue;
    }

    for (const invoice of list.data) {
      await upsertInvoiceFromStripe(invoice, sub.id);
      invoiceCount += 1;
      console.log(
        `  ✓ ${invoice.id} — ${invoice.status} — ` +
          `${(invoice.total / 100).toFixed(2)} ${invoice.currency.toUpperCase()}`,
      );
    }
  }

  console.log(
    `\nDone. Backfilled ${invoiceCount} invoice(s) across ${subs.length} subscription(s).`,
  );
}

backfill()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  });
