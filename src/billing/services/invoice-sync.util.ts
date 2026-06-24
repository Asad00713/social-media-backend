import { eq, sql } from 'drizzle-orm';
import Stripe from 'stripe';
import { db } from '../../drizzle/db';
import {
  invoices,
  invoiceLineItems,
  NewInvoice,
  NewInvoiceLineItem,
} from '../../drizzle/schema';

/**
 * Resolve the Stripe subscription id from an invoice across API versions.
 *
 * Stripe API `2025-12-15.clover` removed the top-level `invoice.subscription`;
 * it now lives under `parent.subscription_details.subscription`. Read the new
 * path first and fall back to the legacy field for safety.
 */
export function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const inv = invoice as any;
  const raw = inv.parent?.subscription_details?.subscription ?? inv.subscription;
  if (!raw) return null;
  return typeof raw === 'string' ? raw : raw.id;
}

/**
 * Idempotently persist a Stripe invoice (header + line items) into our DB.
 *
 * Keyed on the unique `stripe_invoice_id`, so it is safe to call from the
 * checkout path (with the expanded `latest_invoice`), the `invoice.*` webhook
 * handlers, and the backfill script — duplicate deliveries and out-of-order
 * events just refresh the existing row instead of erroring or duplicating.
 *
 * The subscription link may be null when an invoice event lands before the
 * subscription row exists; a later call with a resolved id fills it in (we never
 * overwrite a real link back to null).
 *
 * NOTE: as of Stripe API `2025-12-15.clover`, line items expose `pricing`
 * instead of `price`, and proration moved to `parent.*_details.proration`.
 */
export async function upsertInvoiceFromStripe(
  stripeInvoice: Stripe.Invoice,
  subscriptionDbId: number | null,
): Promise<void> {
  if (!stripeInvoice.id) return;
  const inv = stripeInvoice as any;

  const invoiceData: Record<string, unknown> = {
    subscriptionId: subscriptionDbId,
    stripeInvoiceId: stripeInvoice.id,
    subtotalCents: inv.subtotal ?? 0,
    taxCents: inv.tax ?? 0,
    totalCents: inv.total ?? 0,
    amountDueCents: inv.amount_due ?? 0,
    amountPaidCents: inv.amount_paid ?? 0,
    currency: stripeInvoice.currency ?? 'usd',
    status: stripeInvoice.status ?? 'draft',
  };
  if (inv.period_start) {
    invoiceData.periodStart = new Date(inv.period_start * 1000);
  }
  if (inv.period_end) {
    invoiceData.periodEnd = new Date(inv.period_end * 1000);
  }
  if (inv.invoice_pdf) invoiceData.invoicePdfUrl = inv.invoice_pdf;
  if (inv.hosted_invoice_url) {
    invoiceData.hostedInvoiceUrl = inv.hosted_invoice_url;
  }
  const paidAtUnix = inv.status_transitions?.paid_at;
  if (paidAtUnix) {
    invoiceData.paidAt = new Date(paidAtUnix * 1000);
  }

  // Build the conflict-update set. Only overwrite the subscription link when we
  // actually resolved one, so a later event missing the link can't null it out.
  const updateSet: Record<string, unknown> = {
    status: sql`excluded.status`,
    subtotalCents: sql`excluded.subtotal_cents`,
    taxCents: sql`excluded.tax_cents`,
    totalCents: sql`excluded.total_cents`,
    amountDueCents: sql`excluded.amount_due_cents`,
    amountPaidCents: sql`excluded.amount_paid_cents`,
    updatedAt: new Date(),
  };
  if (subscriptionDbId != null) {
    updateSet.subscriptionId = sql`excluded.subscription_id`;
  }
  if (invoiceData.periodStart) {
    updateSet.periodStart = sql`excluded.period_start`;
  }
  if (invoiceData.periodEnd) updateSet.periodEnd = sql`excluded.period_end`;
  if (invoiceData.invoicePdfUrl) {
    updateSet.invoicePdfUrl = sql`excluded.invoice_pdf_url`;
  }
  if (invoiceData.hostedInvoiceUrl) {
    updateSet.hostedInvoiceUrl = sql`excluded.hosted_invoice_url`;
  }
  if (invoiceData.paidAt) updateSet.paidAt = sql`excluded.paid_at`;

  await db
    .insert(invoices)
    .values(invoiceData as NewInvoice)
    .onConflictDoUpdate({ target: invoices.stripeInvoiceId, set: updateSet });

  const savedInvoice = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(eq(invoices.stripeInvoiceId, stripeInvoice.id))
    .limit(1);
  const invoiceId = savedInvoice[0]?.id;
  if (!invoiceId) return;

  // Line items have no natural unique key in our schema, so replace-in-place:
  // delete existing rows for this invoice, then re-insert from Stripe.
  const lines = inv.lines?.data;
  if (Array.isArray(lines) && lines.length > 0) {
    await db
      .delete(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoiceId));

    for (const line of lines) {
      const li = line as any;
      const parentDetails =
        li.parent?.subscription_item_details ??
        li.parent?.invoice_item_details ??
        null;
      const unitAmountDecimal = li.pricing?.unit_amount_decimal;
      const lineItemData: Record<string, unknown> = {
        invoiceId,
        stripeLineItemId: li.id,
        description: li.description || 'No description',
        quantity: li.quantity ?? 1,
        unitPriceCents:
          unitAmountDecimal != null ? Math.round(Number(unitAmountDecimal)) : 0,
        totalCents: li.amount ?? 0,
        isProration: parentDetails?.proration ?? false,
      };
      const itemType = li.metadata?.item_type;
      if (itemType) lineItemData.itemType = itemType;
      if (li.period?.start) {
        lineItemData.periodStart = new Date(li.period.start * 1000);
      }
      if (li.period?.end) {
        lineItemData.periodEnd = new Date(li.period.end * 1000);
      }
      await db
        .insert(invoiceLineItems)
        .values(lineItemData as NewInvoiceLineItem);
    }
  }
}
