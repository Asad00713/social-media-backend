import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import {
  paymentMethods,
  stripeCustomers,
  NewPaymentMethod,
} from '../../drizzle/schema';
import { StripeService } from '../../stripe/stripe.service';

export interface PaymentMethodDetails {
  id: number;
  stripePaymentMethodId: string;
  type: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
  createdAt: Date;
}

export interface AddPaymentMethodResult {
  paymentMethod: PaymentMethodDetails;
  isDefault: boolean;
}

@Injectable()
export class PaymentMethodService {
  private readonly logger = new Logger(PaymentMethodService.name);

  constructor(private stripeService: StripeService) {}

  // Get all payment methods for a user
  async getUserPaymentMethods(userId: string): Promise<PaymentMethodDetails[]> {
    // Get user's Stripe customer ID
    const customer = await db
      .select()
      .from(stripeCustomers)
      .where(eq(stripeCustomers.userId, userId))
      .limit(1);

    if (customer.length === 0) {
      return [];
    }

    const methods = await db
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.stripeCustomerId, customer[0].stripeCustomerId));

    return methods.map((pm) => ({
      id: pm.id,
      stripePaymentMethodId: pm.stripePaymentMethodId,
      type: pm.type,
      brand: pm.cardBrand,
      last4: pm.cardLast4,
      expMonth: pm.cardExpMonth,
      expYear: pm.cardExpYear,
      isDefault: pm.isDefault,
      createdAt: pm.createdAt,
    }));
  }

  // Get default payment method for a user
  async getDefaultPaymentMethod(userId: string): Promise<PaymentMethodDetails | null> {
    // Get user's Stripe customer ID
    const customer = await db
      .select()
      .from(stripeCustomers)
      .where(eq(stripeCustomers.userId, userId))
      .limit(1);

    if (customer.length === 0) {
      return null;
    }

    const methods = await db
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.stripeCustomerId, customer[0].stripeCustomerId));

    // Find default or return first one
    const defaultMethod = methods.find((m) => m.isDefault) || methods[0];

    if (!defaultMethod) {
      return null;
    }

    return {
      id: defaultMethod.id,
      stripePaymentMethodId: defaultMethod.stripePaymentMethodId,
      type: defaultMethod.type,
      brand: defaultMethod.cardBrand,
      last4: defaultMethod.cardLast4,
      expMonth: defaultMethod.cardExpMonth,
      expYear: defaultMethod.cardExpYear,
      isDefault: defaultMethod.isDefault,
      createdAt: defaultMethod.createdAt,
    };
  }

  // Add a payment method
  async addPaymentMethod(
    userId: string,
    stripePaymentMethodId: string,
    setAsDefault: boolean = false,
  ): Promise<AddPaymentMethodResult> {
    // Get Stripe customer
    const customer = await db
      .select()
      .from(stripeCustomers)
      .where(eq(stripeCustomers.userId, userId))
      .limit(1);

    if (customer.length === 0) {
      throw new NotFoundException('Stripe customer not found. Please create a subscription first.');
    }

    // Attach payment method to customer in Stripe
    const stripePaymentMethod = await this.stripeService.attachPaymentMethod(
      stripePaymentMethodId,
      customer[0].stripeCustomerId,
    );

    const pm: any = stripePaymentMethod;

    // Check if this is the first payment method
    const existingMethods = await db
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.stripeCustomerId, customer[0].stripeCustomerId));

    const isFirstMethod = existingMethods.length === 0;
    const shouldBeDefault = setAsDefault || isFirstMethod;

    // If setting as default, unset other defaults
    if (shouldBeDefault && existingMethods.length > 0) {
      await db
        .update(paymentMethods)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(paymentMethods.stripeCustomerId, customer[0].stripeCustomerId));
    }

    // Set as default in Stripe if needed
    if (shouldBeDefault) {
      await this.stripeService.setDefaultPaymentMethod(
        customer[0].stripeCustomerId,
        stripePaymentMethodId,
      );
    }

    // Save to database
    const newPaymentMethod: NewPaymentMethod = {
      stripeCustomerId: customer[0].stripeCustomerId,
      stripePaymentMethodId,
      type: pm.type || 'card',
      cardBrand: pm.card?.brand || null,
      cardLast4: pm.card?.last4 || null,
      cardExpMonth: pm.card?.exp_month || null,
      cardExpYear: pm.card?.exp_year || null,
      isDefault: shouldBeDefault,
    };

    const inserted = await db
      .insert(paymentMethods)
      .values(newPaymentMethod)
      .returning();

    this.logger.log(`Added payment method ${stripePaymentMethodId} for user ${userId}`);

    return {
      paymentMethod: {
        id: inserted[0].id,
        stripePaymentMethodId: inserted[0].stripePaymentMethodId,
        type: inserted[0].type,
        brand: inserted[0].cardBrand,
        last4: inserted[0].cardLast4,
        expMonth: inserted[0].cardExpMonth,
        expYear: inserted[0].cardExpYear,
        isDefault: inserted[0].isDefault,
        createdAt: inserted[0].createdAt,
      },
      isDefault: shouldBeDefault,
    };
  }

  // Set a payment method as default
  async setDefaultPaymentMethod(
    userId: string,
    paymentMethodId: number,
  ): Promise<PaymentMethodDetails> {
    // Get user's Stripe customer
    const customer = await db
      .select()
      .from(stripeCustomers)
      .where(eq(stripeCustomers.userId, userId))
      .limit(1);

    if (customer.length === 0) {
      throw new NotFoundException('Stripe customer not found');
    }

    // Get the payment method
    const method = await db
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.id, paymentMethodId))
      .limit(1);

    if (method.length === 0) {
      throw new NotFoundException('Payment method not found');
    }

    if (method[0].stripeCustomerId !== customer[0].stripeCustomerId) {
      throw new ForbiddenException('Payment method does not belong to this user');
    }

    // Update in Stripe
    await this.stripeService.setDefaultPaymentMethod(
      customer[0].stripeCustomerId,
      method[0].stripePaymentMethodId,
    );

    // Unset all other defaults
    await db
      .update(paymentMethods)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(eq(paymentMethods.stripeCustomerId, customer[0].stripeCustomerId));

    // Set this one as default
    await db
      .update(paymentMethods)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(paymentMethods.id, paymentMethodId));

    this.logger.log(`Set payment method ${paymentMethodId} as default for user ${userId}`);

    return {
      id: method[0].id,
      stripePaymentMethodId: method[0].stripePaymentMethodId,
      type: method[0].type,
      brand: method[0].cardBrand,
      last4: method[0].cardLast4,
      expMonth: method[0].cardExpMonth,
      expYear: method[0].cardExpYear,
      isDefault: true,
      createdAt: method[0].createdAt,
    };
  }

  // Remove a payment method
  async removePaymentMethod(
    userId: string,
    paymentMethodId: number,
  ): Promise<{ success: boolean; message: string }> {
    // Get user's Stripe customer
    const customer = await db
      .select()
      .from(stripeCustomers)
      .where(eq(stripeCustomers.userId, userId))
      .limit(1);

    if (customer.length === 0) {
      throw new NotFoundException('Stripe customer not found');
    }

    // Get the payment method
    const method = await db
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.id, paymentMethodId))
      .limit(1);

    if (method.length === 0) {
      throw new NotFoundException('Payment method not found');
    }

    if (method[0].stripeCustomerId !== customer[0].stripeCustomerId) {
      throw new ForbiddenException('Payment method does not belong to this user');
    }

    // Check if it's the only payment method
    const allMethods = await db
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.stripeCustomerId, customer[0].stripeCustomerId));

    if (allMethods.length === 1) {
      throw new BadRequestException(
        'Cannot remove the only payment method. Add another payment method first.',
      );
    }

    // If removing default, set another as default
    if (method[0].isDefault) {
      const otherMethod = allMethods.find((m) => m.id !== paymentMethodId);
      if (otherMethod) {
        await this.stripeService.setDefaultPaymentMethod(
          customer[0].stripeCustomerId,
          otherMethod.stripePaymentMethodId,
        );
        await db
          .update(paymentMethods)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(eq(paymentMethods.id, otherMethod.id));
      }
    }

    // Detach from Stripe
    await this.stripeService.detachPaymentMethod(method[0].stripePaymentMethodId);

    // Remove from database
    await db
      .delete(paymentMethods)
      .where(eq(paymentMethods.id, paymentMethodId));

    this.logger.log(`Removed payment method ${paymentMethodId} for user ${userId}`);

    return {
      success: true,
      message: 'Payment method removed successfully',
    };
  }

  // Sync payment methods from Stripe
  async syncPaymentMethodsFromStripe(userId: string): Promise<void> {
    // Get Stripe customer
    const customer = await db
      .select()
      .from(stripeCustomers)
      .where(eq(stripeCustomers.userId, userId))
      .limit(1);

    if (customer.length === 0) {
      return;
    }

    // Get payment methods from Stripe
    const stripeMethods = await this.stripeService.listPaymentMethods(
      customer[0].stripeCustomerId,
    );

    // Get customer to check default payment method
    const stripeCustomer = await this.stripeService.getCustomer(
      customer[0].stripeCustomerId,
    );
    const cust: any = stripeCustomer;
    const defaultPaymentMethodId = cust.invoice_settings?.default_payment_method;

    // Delete all existing local payment methods
    await db
      .delete(paymentMethods)
      .where(eq(paymentMethods.stripeCustomerId, customer[0].stripeCustomerId));

    // Insert fresh from Stripe
    for (const pm of stripeMethods) {
      const method: any = pm;
      await db.insert(paymentMethods).values({
        stripeCustomerId: customer[0].stripeCustomerId,
        stripePaymentMethodId: pm.id,
        type: pm.type || 'card',
        cardBrand: method.card?.brand || null,
        cardLast4: method.card?.last4 || null,
        cardExpMonth: method.card?.exp_month || null,
        cardExpYear: method.card?.exp_year || null,
        isDefault: pm.id === defaultPaymentMethodId,
      });
    }

    this.logger.log(`Synced ${stripeMethods.length} payment methods for user ${userId}`);
  }

  // Create setup intent for adding payment method (frontend uses this)
  async createSetupIntent(userId: string): Promise<{ clientSecret: string }> {
    // Get Stripe customer
    const customer = await db
      .select()
      .from(stripeCustomers)
      .where(eq(stripeCustomers.userId, userId))
      .limit(1);

    if (customer.length === 0) {
      throw new NotFoundException(
        'Stripe customer not found. Please create a subscription first.',
      );
    }

    const stripeClient = this.stripeService.getClient();
    const setupIntent = await stripeClient.setupIntents.create({
      customer: customer[0].stripeCustomerId,
      payment_method_types: ['card'],
    });

    return {
      clientSecret: setupIntent.client_secret || '',
    };
  }
}
