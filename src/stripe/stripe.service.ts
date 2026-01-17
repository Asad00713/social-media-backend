import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { db } from '../drizzle/db';
import { invoices, invoiceLineItems, subscriptions, paymentMethods, stripeCustomers } from '../drizzle/schema';
import { eq } from 'drizzle-orm';

@Injectable()
export class StripeService implements OnModuleInit {
  private stripe: Stripe;
  private readonly logger = new Logger(StripeService.name);

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    const apiKey = this.configService.get<string>('STRIPE_SECRET_KEY');

    if (!apiKey) {
      throw new Error('STRIPE_SECRET_KEY is not defined in environment variables');
    }

    this.stripe = new Stripe(apiKey, {
      apiVersion: '2025-12-15.clover',
      typescript: true,
    });
  }

  getClient(): Stripe {
    return this.stripe;
  }

  // Customer Methods
  async createCustomer(params: {
    email: string;
    name?: string;
    metadata?: Record<string, string>;
  }): Promise<Stripe.Customer> {
    return await this.stripe.customers.create({
      email: params.email,
      name: params.name,
      metadata: params.metadata,
    });
  }

  async getCustomer(customerId: string): Promise<Stripe.Customer> {
    return await this.stripe.customers.retrieve(customerId) as Stripe.Customer;
  }

  async updateCustomer(
    customerId: string,
    params: Stripe.CustomerUpdateParams,
  ): Promise<Stripe.Customer> {
    return await this.stripe.customers.update(customerId, params);
  }

  // Subscription Methods
  async createSubscription(params: {
    customerId: string;
    priceId: string;
    metadata?: Record<string, string>;
    trialPeriodDays?: number;
  }): Promise<Stripe.Subscription> {
    const subscriptionParams: Stripe.SubscriptionCreateParams = {
      customer: params.customerId,
      items: [{ price: params.priceId }],
      metadata: params.metadata,
      payment_behavior: 'default_incomplete',
      payment_settings: {
        save_default_payment_method: 'on_subscription',
      },
      expand: ['latest_invoice.payment_intent'],
    };

    if (params.trialPeriodDays) {
      subscriptionParams.trial_period_days = params.trialPeriodDays;
    }

    return await this.stripe.subscriptions.create(subscriptionParams);
  }

  async getSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    return await this.stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['default_payment_method', 'latest_invoice'],
    });
  }

  async updateSubscription(
    subscriptionId: string,
    params: Stripe.SubscriptionUpdateParams,
  ): Promise<Stripe.Subscription> {
    return await this.stripe.subscriptions.update(subscriptionId, params);
  }

  async cancelSubscription(
    subscriptionId: string,
    cancelAtPeriodEnd: boolean = true,
  ): Promise<Stripe.Subscription> {
    if (cancelAtPeriodEnd) {
      return await this.stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: true,
      });
    } else {
      return await this.stripe.subscriptions.cancel(subscriptionId);
    }
  }

  // Subscription Item Methods (for add-ons)
  // Industry standard: Charge full price immediately for add-ons
  async addSubscriptionItem(params: {
    subscriptionId: string;
    priceId: string;
    quantity: number;
  }): Promise<Stripe.SubscriptionItem> {
    this.logger.log(`addSubscriptionItem called with: subscriptionId=${params.subscriptionId}, priceId=${params.priceId}, quantity=${params.quantity}`);

    // Get the subscription to find the customer ID
    const subscription = await this.stripe.subscriptions.retrieve(params.subscriptionId, {
      expand: ['default_payment_method'],
    });
    const customerId = typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer.id;

    // Get the payment method from subscription
    const paymentMethodId = typeof subscription.default_payment_method === 'string'
      ? subscription.default_payment_method
      : subscription.default_payment_method?.id;

    // Save payment method to database if present
    if (subscription.default_payment_method && typeof subscription.default_payment_method !== 'string') {
      await this.savePaymentMethodToDatabase(customerId, subscription.default_payment_method);
    }

    // Add the subscription item WITHOUT proration (it will be billed starting next cycle)
    const item = await this.stripe.subscriptionItems.create({
      subscription: params.subscriptionId,
      price: params.priceId,
      quantity: params.quantity,
      proration_behavior: 'none', // Don't create $0 proration items
    });

    // Get the price details to know the amount
    const price = await this.stripe.prices.retrieve(params.priceId);
    const unitAmount = price.unit_amount || 0;
    const totalAmount = unitAmount * params.quantity;

    this.logger.log(`Add-on price: ${unitAmount} cents, quantity: ${params.quantity}, total: ${totalAmount} cents`);

    if (totalAmount > 0) {
      // Create a draft invoice FIRST
      const invoice = await this.stripe.invoices.create({
        customer: customerId,
        auto_advance: false, // Don't auto-advance, we control finalization
        pending_invoice_items_behavior: 'exclude', // Don't include other pending items
      });

      this.logger.log(`Created draft invoice: ${invoice.id}`);

      // Create invoice item and attach it to the specific invoice
      const invoiceItem = await this.stripe.invoiceItems.create({
        customer: customerId,
        invoice: invoice.id, // Attach to this specific invoice
        amount: totalAmount,
        currency: price.currency,
        description: `Add-on: ${params.quantity}x (first month charge)`,
      });

      this.logger.log(`Created invoice item: ${invoiceItem.id} for ${totalAmount} cents, attached to invoice ${invoice.id}`);

      // Finalize the invoice to lock in the amount
      const finalizedInvoice = await this.stripe.invoices.finalizeInvoice(invoice.id);

      this.logger.log(`Finalized invoice: ${finalizedInvoice.id}, amount_due: ${finalizedInvoice.amount_due}`);

      // Now pay the invoice
      let paidInvoice = finalizedInvoice;
      if (finalizedInvoice.amount_due > 0) {
        if (paymentMethodId) {
          paidInvoice = await this.stripe.invoices.pay(finalizedInvoice.id, {
            payment_method: paymentMethodId,
          });
          this.logger.log(`Paid invoice ${finalizedInvoice.id} with payment method ${paymentMethodId}`);
        } else {
          paidInvoice = await this.stripe.invoices.pay(finalizedInvoice.id);
          this.logger.log(`Paid invoice ${finalizedInvoice.id} with default payment method`);
        }
      }

      // Save invoice to database
      await this.saveInvoiceToDatabase(paidInvoice, params.subscriptionId, invoiceItem);
    }

    return item;
  }

  /**
   * Save a Stripe invoice to the database
   */
  private async saveInvoiceToDatabase(
    stripeInvoice: Stripe.Invoice,
    stripeSubscriptionId: string,
    lineItem: Stripe.InvoiceItem,
  ): Promise<void> {
    try {
      // Find subscription ID in our database
      const subscription = await db
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId))
        .limit(1);

      const subscriptionId = subscription.length > 0 ? subscription[0].id : null;

      // Insert invoice
      const [savedInvoice] = await db
        .insert(invoices)
        .values({
          subscriptionId,
          stripeInvoiceId: stripeInvoice.id,
          subtotalCents: stripeInvoice.subtotal || 0,
          taxCents: (stripeInvoice as any).tax || 0,
          totalCents: stripeInvoice.total || 0,
          amountPaidCents: stripeInvoice.amount_paid || 0,
          amountDueCents: stripeInvoice.amount_due || 0,
          currency: stripeInvoice.currency || 'usd',
          status: stripeInvoice.status || 'paid',
          periodStart: stripeInvoice.period_start ? new Date(stripeInvoice.period_start * 1000) : null,
          periodEnd: stripeInvoice.period_end ? new Date(stripeInvoice.period_end * 1000) : null,
          paidAt: stripeInvoice.status === 'paid' ? new Date() : null,
          invoicePdfUrl: stripeInvoice.invoice_pdf || null,
          hostedInvoiceUrl: stripeInvoice.hosted_invoice_url || null,
        })
        .returning();

      this.logger.log(`Saved invoice ${stripeInvoice.id} to database with ID ${savedInvoice.id}`);

      // Insert line item
      await db.insert(invoiceLineItems).values({
        invoiceId: savedInvoice.id,
        stripeLineItemId: lineItem.id,
        description: lineItem.description || 'Add-on charge',
        itemType: 'ADDON',
        quantity: lineItem.quantity || 1,
        unitPriceCents: lineItem.amount || 0,
        totalCents: lineItem.amount || 0,
        isProration: false,
      });

      this.logger.log(`Saved invoice line item for invoice ${savedInvoice.id}`);
    } catch (error) {
      this.logger.error(`Failed to save invoice to database: ${error.message}`, error.stack);
      // Don't throw - invoice was already paid in Stripe, we just failed to save locally
    }
  }

  async updateSubscriptionItem(
    itemId: string,
    quantity: number,
    subscriptionId?: string,
  ): Promise<Stripe.SubscriptionItem> {
    const item = await this.stripe.subscriptionItems.update(itemId, {
      quantity,
      proration_behavior: 'create_prorations',
    });

    // If subscription ID provided, invoice immediately for the change
    if (subscriptionId) {
      await this.invoiceSubscriptionImmediately(subscriptionId);
    }

    return item;
  }

  async deleteSubscriptionItem(itemId: string): Promise<any> {
    // For deletions, prorations create credits which are automatically
    // applied to the next invoice - no need to invoice immediately
    return await this.stripe.subscriptionItems.del(itemId, {
      proration_behavior: 'create_prorations',
    });
  }

  /**
   * Creates and pays an invoice immediately for any pending proration charges
   * Industry standard approach for immediate billing of add-ons/upgrades
   */
  private async invoiceSubscriptionImmediately(subscriptionId: string): Promise<Stripe.Invoice | null> {
    try {
      // First, get the subscription to find the customer ID and payment method
      const subscription = await this.stripe.subscriptions.retrieve(subscriptionId, {
        expand: ['default_payment_method'],
      });
      const customerId = typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer.id;

      // Get the payment method from subscription (where it's saved via 'on_subscription')
      const paymentMethodId = typeof subscription.default_payment_method === 'string'
        ? subscription.default_payment_method
        : subscription.default_payment_method?.id;

      // Create an invoice for any pending invoice items (prorations)
      const invoice = await this.stripe.invoices.create({
        customer: customerId,
        subscription: subscriptionId,
        auto_advance: true, // Automatically finalize and attempt payment
      });

      // If there are line items to charge, pay the invoice immediately
      if (invoice.amount_due > 0) {
        // Use the subscription's payment method if available
        const payParams: Stripe.InvoicePayParams = {};
        if (paymentMethodId) {
          payParams.payment_method = paymentMethodId;
        }
        const paidInvoice = await this.stripe.invoices.pay(invoice.id, payParams);

        // Save invoice to database
        await this.saveProrationInvoiceToDatabase(paidInvoice, subscriptionId);

        return paidInvoice;
      }

      // If invoice is $0 or credit, just finalize it
      if (invoice.status === 'draft') {
        return await this.stripe.invoices.finalizeInvoice(invoice.id);
      }

      return invoice;
    } catch (error: any) {
      // Handle expected errors gracefully
      if (
        error.code === 'invoice_no_subscription_line_items' ||
        error.code === 'nothing_to_invoice'
      ) {
        // No pending items to invoice - that's okay
        return null;
      }
      if (error.code === 'invoice_payment_intent_requires_action') {
        // Payment requires additional authentication - will be handled by webhook
        return null;
      }
      throw error;
    }
  }

  /**
   * Save a proration invoice to the database (for subscription updates)
   */
  private async saveProrationInvoiceToDatabase(
    stripeInvoice: Stripe.Invoice,
    stripeSubscriptionId: string,
  ): Promise<void> {
    try {
      // Find subscription ID in our database
      const subscription = await db
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId))
        .limit(1);

      const subscriptionId = subscription.length > 0 ? subscription[0].id : null;

      // Insert invoice
      const [savedInvoice] = await db
        .insert(invoices)
        .values({
          subscriptionId,
          stripeInvoiceId: stripeInvoice.id,
          subtotalCents: stripeInvoice.subtotal || 0,
          taxCents: (stripeInvoice as any).tax || 0,
          totalCents: stripeInvoice.total || 0,
          amountPaidCents: stripeInvoice.amount_paid || 0,
          amountDueCents: stripeInvoice.amount_due || 0,
          currency: stripeInvoice.currency || 'usd',
          status: stripeInvoice.status || 'paid',
          periodStart: stripeInvoice.period_start ? new Date(stripeInvoice.period_start * 1000) : null,
          periodEnd: stripeInvoice.period_end ? new Date(stripeInvoice.period_end * 1000) : null,
          paidAt: stripeInvoice.status === 'paid' ? new Date() : null,
          invoicePdfUrl: stripeInvoice.invoice_pdf || null,
          hostedInvoiceUrl: stripeInvoice.hosted_invoice_url || null,
        })
        .returning();

      this.logger.log(`Saved proration invoice ${stripeInvoice.id} to database with ID ${savedInvoice.id}`);

      // Save line items from the invoice
      const invoiceWithLines = await this.stripe.invoices.retrieve(stripeInvoice.id, {
        expand: ['lines.data'],
      });

      if (invoiceWithLines.lines?.data) {
        for (const line of invoiceWithLines.lines.data) {
          const lineAny = line as any;
          const isProration = lineAny.proration || false;
          await db.insert(invoiceLineItems).values({
            invoiceId: savedInvoice.id,
            stripeLineItemId: line.id,
            description: line.description || 'Subscription charge',
            itemType: isProration ? 'PRORATION' : 'SUBSCRIPTION',
            quantity: line.quantity || 1,
            unitPriceCents: line.amount || 0,
            totalCents: line.amount || 0,
            periodStart: line.period?.start ? new Date(line.period.start * 1000) : null,
            periodEnd: line.period?.end ? new Date(line.period.end * 1000) : null,
            isProration,
          });
        }
        this.logger.log(`Saved ${invoiceWithLines.lines.data.length} line items for invoice ${savedInvoice.id}`);
      }
    } catch (error) {
      this.logger.error(`Failed to save proration invoice to database: ${error.message}`, error.stack);
    }
  }

  // Price Methods
  async createPrice(params: {
    productId: string;
    unitAmount: number;
    currency?: string;
    recurring?: {
      interval: 'month' | 'year';
    };
    metadata?: Record<string, string>;
  }): Promise<Stripe.Price> {
    return await this.stripe.prices.create({
      product: params.productId,
      unit_amount: params.unitAmount,
      currency: params.currency || 'usd',
      recurring: params.recurring,
      metadata: params.metadata,
    });
  }

  async getPrice(priceId: string): Promise<Stripe.Price> {
    return await this.stripe.prices.retrieve(priceId);
  }

  // Product Methods
  async createProduct(params: {
    name: string;
    description?: string;
    metadata?: Record<string, string>;
  }): Promise<Stripe.Product> {
    return await this.stripe.products.create({
      name: params.name,
      description: params.description,
      metadata: params.metadata,
    });
  }

  /**
   * Get or create a Stripe product and price for a plan
   * This creates products/prices dynamically so you don't need to pre-configure them in Stripe Dashboard
   */
  async getOrCreatePriceForPlan(params: {
    planCode: string;
    planName: string;
    priceCents: number;
    interval?: 'month' | 'year';
  }): Promise<string> {
    // Search for existing product by metadata
    const existingProducts = await this.stripe.products.search({
      query: `metadata['planCode']:'${params.planCode}'`,
    });

    let productId: string;

    if (existingProducts.data.length > 0) {
      productId = existingProducts.data[0].id;
    } else {
      // Create new product
      const product = await this.stripe.products.create({
        name: params.planName,
        metadata: {
          planCode: params.planCode,
        },
      });
      productId = product.id;
    }

    // Search for existing price
    const existingPrices = await this.stripe.prices.list({
      product: productId,
      active: true,
    });

    // Find a price that matches our amount and interval
    const matchingPrice = existingPrices.data.find(
      (p) =>
        p.unit_amount === params.priceCents &&
        p.recurring?.interval === (params.interval || 'month'),
    );

    if (matchingPrice) {
      return matchingPrice.id;
    }

    // Create new price
    const price = await this.stripe.prices.create({
      product: productId,
      unit_amount: params.priceCents,
      currency: 'usd',
      recurring: {
        interval: params.interval || 'month',
      },
      metadata: {
        planCode: params.planCode,
      },
    });

    return price.id;
  }

  /**
   * Get or create a Stripe product and price for an add-on
   * This creates products/prices dynamically so you don't need to pre-configure them in Stripe Dashboard
   */
  async getOrCreatePriceForAddon(params: {
    addonType: string;
    planCode: string;
    priceCents: number;
    interval?: 'month' | 'year';
  }): Promise<string> {
    const addonKey = `${params.planCode}_${params.addonType}`;
    const addonName = this.getAddonDisplayName(params.addonType, params.planCode);

    // Search for existing product by metadata
    const existingProducts = await this.stripe.products.search({
      query: `metadata['addonKey']:'${addonKey}'`,
    });

    let productId: string;

    if (existingProducts.data.length > 0) {
      productId = existingProducts.data[0].id;
    } else {
      // Create new product
      const product = await this.stripe.products.create({
        name: addonName,
        metadata: {
          addonKey,
          addonType: params.addonType,
          planCode: params.planCode,
        },
      });
      productId = product.id;
    }

    // Search for existing price
    const existingPrices = await this.stripe.prices.list({
      product: productId,
      active: true,
    });

    // Find a price that matches our amount and interval
    const matchingPrice = existingPrices.data.find(
      (p) =>
        p.unit_amount === params.priceCents &&
        p.recurring?.interval === (params.interval || 'month'),
    );

    if (matchingPrice) {
      return matchingPrice.id;
    }

    // Create new price
    const price = await this.stripe.prices.create({
      product: productId,
      unit_amount: params.priceCents,
      currency: 'usd',
      recurring: {
        interval: params.interval || 'month',
      },
      metadata: {
        addonKey,
        addonType: params.addonType,
        planCode: params.planCode,
      },
    });

    return price.id;
  }

  private getAddonDisplayName(addonType: string, planCode: string): string {
    const addonNames: Record<string, string> = {
      EXTRA_CHANNEL: 'Extra Channel',
      EXTRA_MEMBER: 'Extra Team Member',
      EXTRA_WORKSPACE: 'Extra Workspace',
    };
    return `${addonNames[addonType] || addonType} (${planCode})`;
  }

  // Payment Method Methods
  async attachPaymentMethod(
    paymentMethodId: string,
    customerId: string,
  ): Promise<Stripe.PaymentMethod> {
    return await this.stripe.paymentMethods.attach(paymentMethodId, {
      customer: customerId,
    });
  }

  async detachPaymentMethod(
    paymentMethodId: string,
  ): Promise<Stripe.PaymentMethod> {
    return await this.stripe.paymentMethods.detach(paymentMethodId);
  }

  async setDefaultPaymentMethod(
    customerId: string,
    paymentMethodId: string,
  ): Promise<Stripe.Customer> {
    return await this.stripe.customers.update(customerId, {
      invoice_settings: {
        default_payment_method: paymentMethodId,
      },
    });
  }

  async listPaymentMethods(
    customerId: string,
  ): Promise<Stripe.PaymentMethod[]> {
    const paymentMethods = await this.stripe.paymentMethods.list({
      customer: customerId,
      type: 'card',
    });
    return paymentMethods.data;
  }

  // Invoice Methods
  async getInvoice(invoiceId: string): Promise<Stripe.Invoice> {
    return await this.stripe.invoices.retrieve(invoiceId);
  }

  async listInvoices(params: {
    customerId?: string;
    subscriptionId?: string;
    limit?: number;
  }): Promise<Stripe.Invoice[]> {
    const invoices = await this.stripe.invoices.list({
      customer: params.customerId,
      subscription: params.subscriptionId,
      limit: params.limit || 10,
    });
    return invoices.data;
  }

  // Webhook Methods
  constructWebhookEvent(
    payload: string | Buffer,
    signature: string,
  ): Stripe.Event {
    const webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET');

    if (!webhookSecret) {
      throw new Error('STRIPE_WEBHOOK_SECRET is not defined');
    }

    return this.stripe.webhooks.constructEvent(
      payload,
      signature,
      webhookSecret,
    );
  }

  // Upcoming Invoice (for proration preview)
  async getUpcomingInvoice(params: {
    customerId: string;
    subscriptionId?: string;
    subscriptionItems?: any;
  }): Promise<Stripe.Invoice> {
    return await this.stripe.invoices.list({
      customer: params.customerId,
      subscription: params.subscriptionId,
      limit: 1,
    }).then(invoices => invoices.data[0]);
  }

  /**
   * Save a payment method to the database if it doesn't already exist
   */
  private async savePaymentMethodToDatabase(
    stripeCustomerId: string,
    paymentMethod: Stripe.PaymentMethod,
  ): Promise<void> {
    try {
      // Check if this payment method already exists in our database
      const existing = await db
        .select()
        .from(paymentMethods)
        .where(eq(paymentMethods.stripePaymentMethodId, paymentMethod.id))
        .limit(1);

      if (existing.length > 0) {
        this.logger.log(`Payment method ${paymentMethod.id} already exists in database`);
        return;
      }

      // Check if customer exists in our database
      const customer = await db
        .select()
        .from(stripeCustomers)
        .where(eq(stripeCustomers.stripeCustomerId, stripeCustomerId))
        .limit(1);

      if (customer.length === 0) {
        this.logger.warn(`Stripe customer ${stripeCustomerId} not found in database, skipping payment method save`);
        return;
      }

      // Check if this is the first payment method for this customer
      const existingMethods = await db
        .select()
        .from(paymentMethods)
        .where(eq(paymentMethods.stripeCustomerId, stripeCustomerId));

      const isFirstMethod = existingMethods.length === 0;

      // Save the payment method
      const pm = paymentMethod as any;
      await db.insert(paymentMethods).values({
        stripeCustomerId,
        stripePaymentMethodId: paymentMethod.id,
        type: paymentMethod.type || 'card',
        cardBrand: pm.card?.brand || null,
        cardLast4: pm.card?.last4 || null,
        cardExpMonth: pm.card?.exp_month || null,
        cardExpYear: pm.card?.exp_year || null,
        isDefault: isFirstMethod, // First payment method is default
      });

      this.logger.log(`Saved payment method ${paymentMethod.id} to database (isDefault: ${isFirstMethod})`);
    } catch (error) {
      this.logger.error(`Failed to save payment method to database: ${error.message}`, error.stack);
    }
  }
}
