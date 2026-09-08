import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { DbType } from '../../drizzle/db';
import {
  providerSubscriptions,
  subscriptions,
  ProviderItemType,
} from '../../drizzle/schema';
import { CatalogueService } from './catalogue.service';
import { CustomerService } from '../services/customer.service';
import { StripeService } from '../../stripe/stripe.service';
import { assertProviderIsStripe } from '../../stripe/stripe-guard.util';
import { pickDefaultProvider } from '../services/provider-subscription.util';
import {
  PaymentProviderAdapter,
  PurchaseResult,
} from './payment-provider.interface';

const PROVIDER = 'stripe' as const;

/** The subset of a `provider_subscriptions` row this adapter acts on. */
interface ProviderRow {
  id: number;
  itemType: string;
  providerSubscriptionId: string | null;
  providerItemId: string | null;
  provider: string;
  isDefault: boolean;
}

/**
 * Stripe, expressed as our billing intent.
 *
 * Unlike Lemon Squeezy, one Stripe subscription carries N items — the base
 * plan and every add-on live as line items on a SINGLE subscription. There is
 * no fan-out here: `cancel`, `pause`, and `resume` are each one call against
 * the subscription id shared by every row for this account, and an add-on
 * purchase either adds a new item or updates the quantity of an existing one,
 * completing server-side instead of redirecting to a hosted checkout.
 *
 * `getOrCreateStripeCustomer` is called ONLY from `createCheckout` here. That
 * used to run unconditionally at the top of `SubscriptionService.createSubscription`,
 * before the plan was even read — so a Lemon Squeezy signup would still create
 * a Stripe customer and write `stripe_customer_id`, silently. Moving it inside
 * this adapter means it only runs when Stripe was actually selected.
 */
@Injectable()
export class StripeAdapter implements PaymentProviderAdapter {
  readonly name = PROVIDER;

  constructor(
    @Inject(DRIZZLE) private db: DbType,
    private readonly stripe: StripeService,
    private readonly customers: CustomerService,
    private readonly catalogue: CatalogueService,
  ) {}

  // ---------------------------------------------------------------- checkout

  /**
   * The one exception to the Task 6 guard: no `provider_subscriptions` row
   * exists yet for a brand-new signup, so there is nothing to check against.
   */
  async createCheckout(
    userId: string,
    planCode: string,
    workspaceId: string,
  ): Promise<{ url: string }> {
    const { stripeCustomerId } =
      await this.customers.getOrCreateStripeCustomer(userId);
    const priceId = await this.catalogue.resolveRef(
      PROVIDER,
      planCode,
      'BASE_PLAN',
    );

    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3001';
    const base = `${frontendUrl}/w/${workspaceId}/settings/plans`;

    const session = await this.stripe.createCheckoutSession({
      customerId: stripeCustomerId,
      priceId,
      successUrl: `${base}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}?checkout=cancelled`,
      metadata: {
        workspaceId,
        userId,
        planCode,
      },
    });

    if (!session.url) {
      throw new BadRequestException('Failed to create checkout session');
    }
    return { url: session.url };
  }

  // ------------------------------------------------------------------- plan

  async changePlan(subscriptionId: number, newPlanCode: string): Promise<void> {
    const rows = await this.rowsFor(subscriptionId);
    const base = this.require(rows, 'BASE_PLAN', subscriptionId);
    const priceId = await this.catalogue.resolveRef(
      PROVIDER,
      newPlanCode,
      'BASE_PLAN',
    );

    if (!base.providerItemId) {
      throw new BadRequestException(
        `Subscription ${subscriptionId} has no Stripe line item for its base plan.`,
      );
    }

    await this.stripe.updateSubscriptionItem(
      base.providerItemId,
      1,
      base.providerSubscriptionId ?? undefined,
    );

    await this.db
      .update(providerSubscriptions)
      .set({ providerPriceId: priceId, updatedAt: new Date() })
      .where(eq(providerSubscriptions.id, base.id));
  }

  // ----------------------------------------------------------------- add-ons

  /**
   * Stripe can add a line item and invoice immediately, so this always
   * completes here — it never returns `checkout_required`, unlike Lemon
   * Squeezy where a brand-new add-on has to start at a hosted checkout.
   */
  async purchaseAddon(
    subscriptionId: number,
    itemType: ProviderItemType,
    quantity: number,
  ): Promise<PurchaseResult> {
    const rows = await this.rowsFor(subscriptionId);
    const existing = rows.find((r) => r.itemType === itemType);

    if (existing?.providerItemId) {
      await this.changeAddonQuantity(subscriptionId, itemType, quantity);
      return { status: 'completed', quantity };
    }

    const base = this.require(rows, 'BASE_PLAN', subscriptionId);
    if (!base.providerSubscriptionId) {
      throw new BadRequestException(
        `Subscription ${subscriptionId} has no Stripe subscription to add an item to.`,
      );
    }

    const { planCode } = await this.accountOf(subscriptionId);
    const priceId = await this.catalogue.resolveRef(
      PROVIDER,
      planCode,
      itemType,
    );

    const item = await this.stripe.addSubscriptionItem({
      subscriptionId: base.providerSubscriptionId,
      priceId,
      quantity,
    });

    await this.db
      .insert(providerSubscriptions)
      .values({
        subscriptionId,
        provider: PROVIDER,
        itemType,
        providerSubscriptionId: base.providerSubscriptionId,
        providerItemId: item.id,
        providerPriceId: priceId,
        providerQuantity: quantity,
        isDefault: true,
      })
      .onConflictDoUpdate({
        target: [
          providerSubscriptions.subscriptionId,
          providerSubscriptions.provider,
          providerSubscriptions.itemType,
        ],
        set: {
          providerItemId: item.id,
          providerPriceId: priceId,
          providerQuantity: quantity,
          updatedAt: new Date(),
        },
      });

    return { status: 'completed', quantity };
  }

  async changeAddonQuantity(
    subscriptionId: number,
    itemType: ProviderItemType,
    quantity: number,
  ): Promise<void> {
    const rows = await this.rowsFor(subscriptionId);
    const row = this.require(rows, itemType, subscriptionId);

    if (!row.providerItemId) {
      throw new BadRequestException(
        `Subscription ${subscriptionId} has no Stripe ${itemType} line item to change.`,
      );
    }

    await this.stripe.updateSubscriptionItem(
      row.providerItemId,
      quantity,
      row.providerSubscriptionId ?? undefined,
    );

    await this.db
      .update(providerSubscriptions)
      .set({ providerQuantity: quantity, updatedAt: new Date() })
      .where(eq(providerSubscriptions.id, row.id));
  }

  /**
   * An add-on IS a line item here, so removing it deletes the subscription
   * ITEM rather than cancelling a whole subscription.
   */
  async removeAddon(
    subscriptionId: number,
    itemType: ProviderItemType,
  ): Promise<void> {
    const rows = await this.rowsFor(subscriptionId);
    const row = this.require(rows, itemType, subscriptionId);

    if (!row.providerItemId) {
      throw new BadRequestException(
        `Subscription ${subscriptionId} has no Stripe ${itemType} line item to remove.`,
      );
    }

    await this.stripe.deleteSubscriptionItem(row.providerItemId);

    await this.db
      .update(providerSubscriptions)
      .set({
        providerStatus: 'removed',
        updatedAt: new Date(),
      })
      .where(eq(providerSubscriptions.id, row.id));
  }

  // ------------------------------------------------------------------ cancel

  /**
   * One subscription, one call — no fan-out. Every row for this account
   * shares the same `providerSubscriptionId`, so cancelling the base plan's
   * is enough.
   */
  async cancel(subscriptionId: number, atPeriodEnd: boolean): Promise<void> {
    const rows = await this.rowsFor(subscriptionId);
    const base = this.require(rows, 'BASE_PLAN', subscriptionId);
    if (!base.providerSubscriptionId) {
      throw new BadRequestException(
        `Subscription ${subscriptionId} has no Stripe subscription to cancel.`,
      );
    }

    await this.stripe.cancelSubscription(
      base.providerSubscriptionId,
      atPeriodEnd,
    );

    await this.db
      .update(providerSubscriptions)
      .set({
        providerStatus: atPeriodEnd ? 'cancel_scheduled' : 'canceled',
        updatedAt: new Date(),
      })
      .where(eq(providerSubscriptions.id, base.id));
  }

  // ------------------------------------------------------------ pause/resume

  async pause(subscriptionId: number): Promise<void> {
    const rows = await this.rowsFor(subscriptionId);
    const base = this.require(rows, 'BASE_PLAN', subscriptionId);
    if (!base.providerSubscriptionId) {
      throw new BadRequestException(
        `Subscription ${subscriptionId} has no Stripe subscription to pause.`,
      );
    }

    await this.stripe.pauseSubscription(base.providerSubscriptionId);

    await this.db
      .update(providerSubscriptions)
      .set({ providerStatus: 'paused', updatedAt: new Date() })
      .where(eq(providerSubscriptions.id, base.id));
  }

  async resume(subscriptionId: number): Promise<void> {
    const rows = await this.rowsFor(subscriptionId);
    const base = this.require(rows, 'BASE_PLAN', subscriptionId);
    if (!base.providerSubscriptionId) {
      throw new BadRequestException(
        `Subscription ${subscriptionId} has no Stripe subscription to resume.`,
      );
    }

    await this.stripe.resumeSubscription(base.providerSubscriptionId);

    await this.db
      .update(providerSubscriptions)
      .set({ providerStatus: 'active', updatedAt: new Date() })
      .where(eq(providerSubscriptions.id, base.id));
  }

  // ------------------------------------------------------------------ shared

  /**
   * Every Stripe row for one of our subscriptions. Refuses before touching
   * Stripe, not after — without this the Task 6 guard is defined, tested, and
   * never called: dead code protecting nothing.
   */
  private async rowsFor(subscriptionId: number): Promise<ProviderRow[]> {
    const rows = await this.db
      .select()
      .from(providerSubscriptions)
      .where(eq(providerSubscriptions.subscriptionId, subscriptionId));

    const typed = rows as ProviderRow[];
    assertProviderIsStripe(pickDefaultProvider(typed as never), subscriptionId);
    return typed;
  }

  /** Naming the item type matters: "not found" alone says nothing actionable. */
  private require(
    rows: ProviderRow[],
    itemType: ProviderItemType,
    subscriptionId: number,
  ): ProviderRow {
    const row = rows.find((r) => r.itemType === itemType);
    if (!row) {
      throw new BadRequestException(
        `Subscription ${subscriptionId} has no ${PROVIDER} ${itemType} to change.`,
      );
    }
    return row;
  }

  private async accountOf(
    subscriptionId: number,
  ): Promise<{ userId: string; planCode: string }> {
    const rows = await this.db
      .select({
        userId: subscriptions.userId,
        planCode: subscriptions.planCode,
      })
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId));

    const row = (rows as { userId: string; planCode: string }[])[0];
    if (!row) {
      throw new BadRequestException(
        `Subscription ${subscriptionId} does not exist.`,
      );
    }
    return row;
  }
}
