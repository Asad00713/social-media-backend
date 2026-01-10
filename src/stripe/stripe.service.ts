import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

@Injectable()
export class StripeService implements OnModuleInit {
  private stripe: Stripe;

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
  async addSubscriptionItem(params: {
    subscriptionId: string;
    priceId: string;
    quantity: number;
  }): Promise<Stripe.SubscriptionItem> {
    return await this.stripe.subscriptionItems.create({
      subscription: params.subscriptionId,
      price: params.priceId,
      quantity: params.quantity,
      proration_behavior: 'create_prorations',
    });
  }

  async updateSubscriptionItem(
    itemId: string,
    quantity: number,
  ): Promise<Stripe.SubscriptionItem> {
    return await this.stripe.subscriptionItems.update(itemId, {
      quantity,
      proration_behavior: 'create_prorations',
    });
  }

  async deleteSubscriptionItem(itemId: string): Promise<any> {
    return await this.stripe.subscriptionItems.del(itemId, {
      proration_behavior: 'create_prorations',
    });
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
}
