import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { eq, desc, and } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import {
  invoices,
  invoiceLineItems,
  subscriptions,
  workspace,
  stripeCustomers,
} from '../../drizzle/schema';
import { StripeService } from '../../stripe/stripe.service';

export interface InvoiceDetails {
  id: number;
  stripeInvoiceId: string;
  subscriptionId: number | null;
  status: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  subtotalFormatted: string;
  taxFormatted: string;
  totalFormatted: string;
  currency: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  paidAt: Date | null;
  invoicePdfUrl: string | null;
  hostedInvoiceUrl: string | null;
  lineItems: {
    id: number;
    description: string;
    quantity: number;
    unitPriceCents: number;
    totalCents: number;
    totalFormatted: string;
  }[];
  createdAt: Date;
}

export interface InvoiceListItem {
  id: number;
  stripeInvoiceId: string;
  status: string;
  totalCents: number;
  totalFormatted: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  paidAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(private stripeService: StripeService) {}

  // Get invoices for a workspace
  async getWorkspaceInvoices(
    workspaceId: string,
    limit: number = 10,
    offset: number = 0,
  ): Promise<{ invoices: InvoiceListItem[]; total: number }> {
    // Get subscription for workspace
    const subscription = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.workspaceId, workspaceId))
      .limit(1);

    if (subscription.length === 0) {
      return { invoices: [], total: 0 };
    }

    const allInvoices = await db
      .select()
      .from(invoices)
      .where(eq(invoices.subscriptionId, subscription[0].id))
      .orderBy(desc(invoices.createdAt));

    const paginatedInvoices = allInvoices.slice(offset, offset + limit);

    const invoiceList: InvoiceListItem[] = paginatedInvoices.map((inv) => ({
      id: inv.id,
      stripeInvoiceId: inv.stripeInvoiceId,
      status: inv.status,
      totalCents: inv.totalCents,
      totalFormatted: `$${(inv.totalCents / 100).toFixed(2)}`,
      periodStart: inv.periodStart,
      periodEnd: inv.periodEnd,
      paidAt: inv.paidAt,
      createdAt: inv.createdAt,
    }));

    return {
      invoices: invoiceList,
      total: allInvoices.length,
    };
  }

  // Get invoice details
  async getInvoiceDetails(invoiceId: number): Promise<InvoiceDetails> {
    const invoice = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .limit(1);

    if (invoice.length === 0) {
      throw new NotFoundException('Invoice not found');
    }

    const inv = invoice[0];

    // Get line items
    const lineItems = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, inv.id));

    return {
      id: inv.id,
      stripeInvoiceId: inv.stripeInvoiceId,
      subscriptionId: inv.subscriptionId,
      status: inv.status,
      subtotalCents: inv.subtotalCents,
      taxCents: inv.taxCents,
      totalCents: inv.totalCents,
      subtotalFormatted: `$${(inv.subtotalCents / 100).toFixed(2)}`,
      taxFormatted: `$${(inv.taxCents / 100).toFixed(2)}`,
      totalFormatted: `$${(inv.totalCents / 100).toFixed(2)}`,
      currency: inv.currency,
      periodStart: inv.periodStart,
      periodEnd: inv.periodEnd,
      paidAt: inv.paidAt,
      invoicePdfUrl: inv.invoicePdfUrl,
      hostedInvoiceUrl: inv.hostedInvoiceUrl,
      lineItems: lineItems.map((item) => ({
        id: item.id,
        description: item.description,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        totalCents: item.totalCents,
        totalFormatted: `$${(item.totalCents / 100).toFixed(2)}`,
      })),
      createdAt: inv.createdAt,
    };
  }

  // Get invoice by Stripe invoice ID
  async getInvoiceByStripeId(stripeInvoiceId: string): Promise<InvoiceDetails | null> {
    const invoice = await db
      .select()
      .from(invoices)
      .where(eq(invoices.stripeInvoiceId, stripeInvoiceId))
      .limit(1);

    if (invoice.length === 0) {
      return null;
    }

    return this.getInvoiceDetails(invoice[0].id);
  }

  // Get invoices for a user (all workspaces)
  async getUserInvoices(
    userId: string,
    limit: number = 10,
    offset: number = 0,
  ): Promise<{ invoices: (InvoiceListItem & { workspaceName: string })[]; total: number }> {
    // Get all user's workspaces
    const workspaces = await db
      .select()
      .from(workspace)
      .where(eq(workspace.ownerId, userId));

    if (workspaces.length === 0) {
      return { invoices: [], total: 0 };
    }

    // Get all subscriptions for these workspaces
    const workspaceIds = workspaces.map((ws) => ws.id);
    const allInvoices: (InvoiceListItem & { workspaceName: string })[] = [];

    for (const ws of workspaces) {
      const subscription = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.workspaceId, ws.id))
        .limit(1);

      if (subscription.length > 0) {
        const wsInvoices = await db
          .select()
          .from(invoices)
          .where(eq(invoices.subscriptionId, subscription[0].id))
          .orderBy(desc(invoices.createdAt));

        for (const inv of wsInvoices) {
          allInvoices.push({
            id: inv.id,
            stripeInvoiceId: inv.stripeInvoiceId,
            status: inv.status,
            totalCents: inv.totalCents,
            totalFormatted: `$${(inv.totalCents / 100).toFixed(2)}`,
            periodStart: inv.periodStart,
            periodEnd: inv.periodEnd,
            paidAt: inv.paidAt,
            createdAt: inv.createdAt,
            workspaceName: ws.name,
          });
        }
      }
    }

    // Sort by date and paginate
    allInvoices.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const paginatedInvoices = allInvoices.slice(offset, offset + limit);

    return {
      invoices: paginatedInvoices,
      total: allInvoices.length,
    };
  }

  // Download invoice PDF (returns URL from Stripe)
  async getInvoicePdfUrl(invoiceId: number): Promise<string> {
    const invoice = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .limit(1);

    if (invoice.length === 0) {
      throw new NotFoundException('Invoice not found');
    }

    // If we have cached PDF URL, return it
    if (invoice[0].invoicePdfUrl) {
      return invoice[0].invoicePdfUrl;
    }

    // Otherwise fetch from Stripe
    const stripeInvoice = await this.stripeService.getInvoice(invoice[0].stripeInvoiceId);

    if (stripeInvoice.invoice_pdf) {
      // Cache the URL
      await db
        .update(invoices)
        .set({ invoicePdfUrl: stripeInvoice.invoice_pdf })
        .where(eq(invoices.id, invoiceId));

      return stripeInvoice.invoice_pdf;
    }

    throw new NotFoundException('Invoice PDF not available');
  }

  // Sync invoice from Stripe (used by webhooks)
  async syncInvoiceFromStripe(stripeInvoiceId: string): Promise<void> {
    const stripeInvoice = await this.stripeService.getInvoice(stripeInvoiceId);
    const inv: any = stripeInvoice;

    // Find subscription by Stripe subscription ID
    if (!inv.subscription) {
      this.logger.warn(`Invoice ${stripeInvoiceId} has no subscription`);
      return;
    }

    const subscription = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, inv.subscription as string))
      .limit(1);

    if (subscription.length === 0) {
      this.logger.warn(`Subscription not found for invoice ${stripeInvoiceId}`);
      return;
    }

    // Check if invoice exists
    const existingInvoice = await db
      .select()
      .from(invoices)
      .where(eq(invoices.stripeInvoiceId, stripeInvoiceId))
      .limit(1);

    const invoiceData = {
      subscriptionId: subscription[0].id,
      status: inv.status || 'draft',
      subtotalCents: inv.subtotal || 0,
      taxCents: inv.tax || 0,
      totalCents: inv.total || 0,
      currency: inv.currency || 'usd',
      periodStart: inv.period_start ? new Date(inv.period_start * 1000) : null,
      periodEnd: inv.period_end ? new Date(inv.period_end * 1000) : null,
      paidAt: inv.status_transitions?.paid_at
        ? new Date(inv.status_transitions.paid_at * 1000)
        : null,
      invoicePdfUrl: inv.invoice_pdf || null,
      hostedInvoiceUrl: inv.hosted_invoice_url || null,
      updatedAt: new Date(),
    };

    if (existingInvoice.length > 0) {
      await db
        .update(invoices)
        .set(invoiceData)
        .where(eq(invoices.id, existingInvoice[0].id));
    } else {
      await db.insert(invoices).values({
        stripeInvoiceId,
        ...invoiceData,
        createdAt: new Date(),
      });
    }

    this.logger.log(`Synced invoice ${stripeInvoiceId}`);
  }

  // Get upcoming invoice preview
  async getUpcomingInvoice(workspaceId: string): Promise<any> {
    // Get subscription
    const subscription = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.workspaceId, workspaceId))
      .limit(1);

    if (subscription.length === 0 || !subscription[0].stripeSubscriptionId) {
      return null;
    }

    // Get workspace owner to find Stripe customer
    const ws = await db
      .select()
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1);

    if (ws.length === 0) {
      return null;
    }

    const customer = await db
      .select()
      .from(stripeCustomers)
      .where(eq(stripeCustomers.userId, ws[0].ownerId))
      .limit(1);

    if (customer.length === 0) {
      return null;
    }

    try {
      const upcomingInvoice = await this.stripeService.getUpcomingInvoice({
        customerId: customer[0].stripeCustomerId,
        subscriptionId: subscription[0].stripeSubscriptionId,
      });

      if (!upcomingInvoice) {
        return null;
      }

      const inv: any = upcomingInvoice;
      return {
        subtotalCents: inv.subtotal || 0,
        taxCents: inv.tax || 0,
        totalCents: inv.total || 0,
        subtotalFormatted: `$${((inv.subtotal || 0) / 100).toFixed(2)}`,
        taxFormatted: `$${((inv.tax || 0) / 100).toFixed(2)}`,
        totalFormatted: `$${((inv.total || 0) / 100).toFixed(2)}`,
        periodStart: inv.period_start ? new Date(inv.period_start * 1000) : null,
        periodEnd: inv.period_end ? new Date(inv.period_end * 1000) : null,
        lineItems: (inv.lines?.data || []).map((line: any) => ({
          description: line.description,
          quantity: line.quantity,
          unitPriceCents: line.unit_amount_excluding_tax || line.amount,
          totalCents: line.amount,
          totalFormatted: `$${(line.amount / 100).toFixed(2)}`,
        })),
      };
    } catch (error) {
      this.logger.warn(`Failed to get upcoming invoice: ${error}`);
      return null;
    }
  }
}
