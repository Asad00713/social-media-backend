import { Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { StripeService } from '../../stripe/stripe.service';
import { db } from '../../drizzle/db';
import { stripeCustomers, users } from '../../drizzle/schema';

@Injectable()
export class CustomerService {
  constructor(private stripeService: StripeService) {}

  async getOrCreateStripeCustomer(userId: string): Promise<{
    stripeCustomerId: string;
    isNew: boolean;
  }> {
    // Check if customer already exists in our database
    const existingCustomer = await db
      .select()
      .from(stripeCustomers)
      .where(eq(stripeCustomers.userId, userId))
      .limit(1);

    if (existingCustomer.length > 0) {
      return {
        stripeCustomerId: existingCustomer[0].stripeCustomerId,
        isNew: false,
      };
    }

    // Get user details
    const user = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (user.length === 0) {
      throw new NotFoundException('User not found');
    }

    // Create Stripe customer
    const stripeCustomer = await this.stripeService.createCustomer({
      email: user[0].email,
      name: user[0].name || undefined,
      metadata: {
        userId: userId,
      },
    });

    // Save to our database
    await db.insert(stripeCustomers).values({
      userId: userId,
      stripeCustomerId: stripeCustomer.id,
      email: user[0].email,
    });

    return {
      stripeCustomerId: stripeCustomer.id,
      isNew: true,
    };
  }

  async getStripeCustomerId(userId: string): Promise<string | null> {
    const customer = await db
      .select()
      .from(stripeCustomers)
      .where(eq(stripeCustomers.userId, userId))
      .limit(1);

    return customer.length > 0 ? customer[0].stripeCustomerId : null;
  }

  async syncPaymentMethods(userId: string): Promise<void> {
    const stripeCustomerId = await this.getStripeCustomerId(userId);

    if (!stripeCustomerId) {
      throw new NotFoundException('Stripe customer not found');
    }

    // Get payment methods from Stripe
    const paymentMethods = await this.stripeService.listPaymentMethods(
      stripeCustomerId,
    );

    // TODO: Sync with database payment_methods table
    // This will be implemented in Phase 6
  }
}
