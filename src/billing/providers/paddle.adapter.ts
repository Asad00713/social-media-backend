import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { DbType } from '../../drizzle/db';
import {
  providerSubscriptions,
  subscriptions,
  users,
  ProviderItemType,
} from '../../drizzle/schema';
import { AppLinks } from '../../email/links/app-links';
import { CatalogueService } from './catalogue.service';
import { PaddleClient } from './paddle.client';
import {
  quantityOf,
  withBasePlanSwapped,
  withItem,
  withoutItem,
} from './paddle-items.util';
import type {
  PaddleCustomer,
  PaddleEnvelope,
  PaddleItemWrite,
  PaddleProrationMode,
  PaddleSubscription,
  PaddleTransaction,
} from './paddle.types';
import {
  BillingProfile,
  PaymentProviderAdapter,
  PortalIntent,
  ProviderInvoice,
  PurchaseResult,
} from './payment-provider.interface';

const PROVIDER = 'paddle' as const;

/**
 * How a mid-cycle add-on or plan change is billed.
 *
 * `prorated_immediately` matches what the product already promises elsewhere:
 * Stripe's `addSubscriptionItem` invoices at once, and the add-on UI says the
 * charge happens now. Paddle has no documented default and REQUIRES the field
 * whenever items change, so it is stated in one place rather than at each call
 * site — a call that forgot it would 400, and one that reached for
 * `do_not_bill` by accident would hand out a paid add-on for free.
 */
const PRORATION: PaddleProrationMode = 'prorated_immediately';

/** The subset of a `provider_subscriptions` row this adapter acts on. */
interface ProviderRow {
  id: number;
  itemType: string;
  providerSubscriptionId: string | null;
  providerCustomerId: string | null;
  providerPriceId: string | null;
  provider: string;
  isDefault: boolean;
}

/**
 * Paddle Billing, expressed as our billing intent.
 *
 * Shaped like `StripeAdapter`, not `LemonSqueezyAdapter`: one Paddle
 * subscription carries N items, so the base plan and every add-on live on a
 * SINGLE subscription and there is no fan-out. `cancel`, `pause` and `resume`
 * are each one call, and an add-on purchase completes server-side rather than
 * redirecting to a hosted checkout.
 *
 * Two things differ from Stripe, and both are why this is not a copy of it:
 *
 * 1. **Updates replace the items array.** Paddle has no "add one item" call.
 *    Every change is `PATCH /subscriptions/{id}` with the COMPLETE list, and
 *    an omitted line is removed from the subscription. So each mutation here
 *    reads the live subscription first and sends the whole list back, through
 *    `paddle-items.util.ts`.
 *
 * 2. **A new subscription starts as a transaction.** There is no "create
 *    subscription" endpoint. `POST /transactions` with recurring items returns
 *    `checkout.url`, and Paddle creates the subscription itself once that
 *    transaction completes — which arrives as a webhook, not as a return
 *    value. `createCheckout` therefore writes no `provider_subscriptions`
 *    row; the webhook service does, when there is a real subscription id to
 *    write.
 */
@Injectable()
export class PaddleAdapter implements PaymentProviderAdapter {
  readonly name = PROVIDER;

  constructor(
    @Inject(DRIZZLE) private db: DbType,
    private readonly paddle: PaddleClient,
    private readonly catalogue: CatalogueService,
    private readonly links: AppLinks,
  ) {}

  // ---------------------------------------------------------------- checkout

  /**
   * The one exception to the provider guard: no `provider_subscriptions` row
   * exists yet for a brand-new signup, so there is nothing to check against.
   *
   * Returns a checkout URL for a TRANSACTION, not a subscription. Paddle
   * creates the subscription when the customer pays, and tells us by webhook.
   */
  async createCheckout(
    userId: string,
    planCode: string,
    workspaceId: string,
  ): Promise<{ url: string }> {
    const priceId = await this.catalogue.resolveRef(
      PROVIDER,
      planCode,
      'BASE_PLAN',
    );
    const customerId = await this.customerIdFor(userId);

    const created = await this.paddle.post<
      PaddleEnvelope<{ id: string; checkout?: { url?: string | null } | null }>
    >('transactions', {
      items: [{ price_id: priceId, quantity: 1 }],
      customer_id: customerId,
      // `automatic` is Paddle's default, but it is the difference between a
      // self-serve checkout and an invoice someone has to be chased for, so
      // it is stated rather than inherited.
      collection_mode: 'automatic',
      // Read back by the webhook service: the transaction that creates the
      // subscription is the only place that knows which workspace asked for
      // it.
      custom_data: {
        workspace_id: workspaceId,
        user_id: userId,
        plan_code: planCode,
      },
      checkout: { url: this.links.billing(workspaceId) },
    });

    const url = created.data.checkout?.url;
    if (!url) {
      // `checkout.url` is null for a transaction Paddle considers `draft`,
      // i.e. one missing a customer or items. Failing here names the cause;
      // returning an empty string would send the customer to a blank page.
      throw new BadRequestException(
        `Paddle returned no checkout URL for transaction ${created.data.id}. ` +
          'The transaction is probably still a draft (missing customer or items).',
      );
    }
    return { url };
  }

  // -------------------------------------------------------------------- plan

  /**
   * Swap the base-plan line, leaving every add-on exactly as it is.
   *
   * The OLD price comes from our own row rather than from the Paddle items,
   * because picking "whichever of these is the plan" out of the array is the
   * guess that would delete an add-on the first time a catalogue id changed.
   */
  async changePlan(subscriptionId: number, newPlanCode: string): Promise<void> {
    const rows = await this.rowsFor(subscriptionId);
    const base = this.require(rows, 'BASE_PLAN', subscriptionId);
    const paddleId = this.subscriptionIdOf(base, subscriptionId, 'change');

    const newPriceId = await this.catalogue.resolveRef(
      PROVIDER,
      newPlanCode,
      'BASE_PLAN',
    );
    const live = await this.fetchSubscription(paddleId);

    const oldPriceId =
      base.providerPriceId ??
      this.soleQuantityOneItem(live, subscriptionId);

    // Already on it. Sending the swap anyway would bill a proration of zero
    // and emit a `subscription.updated` for a change that did not happen.
    if (oldPriceId === newPriceId) return;

    await this.patchItems(
      paddleId,
      withBasePlanSwapped(live.items, oldPriceId, newPriceId),
    );

    await this.db
      .update(providerSubscriptions)
      .set({ providerPriceId: newPriceId, updatedAt: new Date() })
      .where(eq(providerSubscriptions.id, base.id));
  }

  // ----------------------------------------------------------------- add-ons

  /**
   * Paddle can add a line and collect immediately, so this always completes
   * here — it never returns `checkout_required`, unlike Lemon Squeezy where a
   * brand-new add-on has to start at a hosted checkout.
   */
  async purchaseAddon(
    subscriptionId: number,
    itemType: ProviderItemType,
    quantity: number,
  ): Promise<PurchaseResult> {
    const rows = await this.rowsFor(subscriptionId);
    const base = this.require(rows, 'BASE_PLAN', subscriptionId);
    const paddleId = this.subscriptionIdOf(
      base,
      subscriptionId,
      'add an item to',
    );

    const { planCode } = await this.accountOf(subscriptionId);
    const priceId = await this.catalogue.resolveRef(
      PROVIDER,
      planCode,
      itemType,
    );

    const live = await this.fetchSubscription(paddleId);
    await this.patchItems(paddleId, withItem(live.items, priceId, quantity));

    // `isDefault` is FALSE here, and that is not a detail: the flag marks the
    // account's default PROVIDER, carried by exactly one row, and migration
    // `0032` enforces that with a partial unique index. Setting it on an
    // add-on insert would hit a 23505 AFTER Paddle had already put the
    // billable line on the subscription — charged customer, 500 response, no
    // bookkeeping row. The BASE_PLAN row carries it, and `require()` above
    // has already proved that row exists.
    await this.db
      .insert(providerSubscriptions)
      .values({
        subscriptionId,
        provider: PROVIDER,
        itemType,
        providerSubscriptionId: paddleId,
        providerCustomerId: base.providerCustomerId,
        providerPriceId: priceId,
        providerQuantity: quantity,
        isDefault: false,
      })
      .onConflictDoUpdate({
        target: [
          providerSubscriptions.subscriptionId,
          providerSubscriptions.provider,
          providerSubscriptions.itemType,
        ],
        set: {
          providerSubscriptionId: paddleId,
          providerPriceId: priceId,
          providerQuantity: quantity,
          // Cleared on purpose: a row that was removed and bought again is
          // live, and a stale `canceled` here reads as "not billing" to the
          // liveness checks.
          providerStatus: null,
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
    const paddleId = this.subscriptionIdOf(row, subscriptionId, 'change');
    const priceId = this.priceIdOf(row, subscriptionId, itemType);

    const live = await this.fetchSubscription(paddleId);
    if (quantityOf(live.items, priceId) === quantity) {
      // Nothing to send; keep our own count honest and stop.
      await this.syncQuantity(row.id, quantity);
      return;
    }

    await this.patchItems(paddleId, withItem(live.items, priceId, quantity));
    await this.syncQuantity(row.id, quantity);
  }

  /** An add-on IS a line here, so removing it drops the line from the array. */
  async removeAddon(
    subscriptionId: number,
    itemType: ProviderItemType,
  ): Promise<void> {
    const rows = await this.rowsFor(subscriptionId);
    const row = this.require(rows, itemType, subscriptionId);
    const paddleId = this.subscriptionIdOf(
      row,
      subscriptionId,
      'remove an item from',
    );
    const priceId = this.priceIdOf(row, subscriptionId, itemType);

    const live = await this.fetchSubscription(paddleId);
    const next = withoutItem(live.items, priceId);
    if (next.length === 0) {
      // Paddle rejects an empty items array, and an account with no base plan
      // should never reach here. Refuse rather than send a 400 the user reads
      // as "removing my add-on failed for an unknown reason".
      throw new BadRequestException(
        `Removing ${itemType} would leave Paddle subscription ${paddleId} with no items. ` +
          'Cancel the subscription instead.',
      );
    }
    await this.patchItems(paddleId, next);

    // `canceled`, NOT `removed`. The liveness check is a DENY-LIST that fails
    // open, so a status it does not recognise reads as STILL BILLING — which
    // is how a removed add-on once stayed eligible to inherit `is_default`.
    // One spelling per fact.
    await this.db
      .update(providerSubscriptions)
      .set({ providerStatus: 'canceled', updatedAt: new Date() })
      .where(eq(providerSubscriptions.id, row.id));
  }

  // ------------------------------------------------------------------ cancel

  /**
   * One subscription, one call — no fan-out. Every row for this account
   * shares the same `providerSubscriptionId`.
   */
  async cancel(subscriptionId: number, atPeriodEnd: boolean): Promise<void> {
    const rows = await this.rowsFor(subscriptionId);
    const base = this.require(rows, 'BASE_PLAN', subscriptionId);
    const paddleId = this.subscriptionIdOf(base, subscriptionId, 'cancel');

    await this.paddle.post(`subscriptions/${paddleId}/cancel`, {
      effective_from: atPeriodEnd ? 'next_billing_period' : 'immediately',
    });
  }

  // ------------------------------------------------------------ pause/resume

  async pause(subscriptionId: number): Promise<void> {
    const rows = await this.rowsFor(subscriptionId);
    const base = this.require(rows, 'BASE_PLAN', subscriptionId);
    const paddleId = this.subscriptionIdOf(base, subscriptionId, 'pause');

    await this.paddle.post(`subscriptions/${paddleId}/pause`, {
      // At the period end, so someone who paused keeps what they already paid
      // for until it runs out. `immediately` would end their service mid-cycle
      // for money already taken.
      effective_from: 'next_billing_period',
    });
  }

  async resume(subscriptionId: number): Promise<void> {
    const rows = await this.rowsFor(subscriptionId);
    const base = this.require(rows, 'BASE_PLAN', subscriptionId);
    const paddleId = this.subscriptionIdOf(base, subscriptionId, 'resume');

    // Resume now. A `paused` subscription resumes and may be charged at once;
    // an `active` one with a scheduled pause has that pause cancelled.
    await this.paddle.post(`subscriptions/${paddleId}/resume`, {
      effective_from: 'immediately',
    });
  }

  // ----------------------------------------------- portal, invoices, profile

  /**
   * A customer-portal session. Paddle's own doc: "Customer portal sessions are
   * temporary and shouldn't be cached" — the links carry a short-lived token,
   * so one is minted per request.
   *
   * `update_payment_method` opens the card form directly, skipping the
   * portal's overview.
   */
  async createPortalLink(
    subscriptionId: number,
    intent: PortalIntent,
    _opts?: { workspaceId?: string },
  ): Promise<{ url: string }> {
    const rows = await this.rowsFor(subscriptionId);
    const base = this.require(rows, 'BASE_PLAN', subscriptionId);
    const paddleId = this.subscriptionIdOf(
      base,
      subscriptionId,
      'open a portal for',
    );
    const customerId = base.providerCustomerId;
    if (!customerId) {
      throw new BadRequestException(
        `Subscription ${subscriptionId} has no Paddle customer to open a portal for.`,
      );
    }

    const session = await this.paddle.post<
      PaddleEnvelope<{
        urls?: {
          general?: { overview?: string | null } | null;
          subscriptions?: {
            id: string;
            update_subscription_payment_method?: string | null;
            cancel_subscription?: string | null;
          }[];
        } | null;
      }>
    >(`customers/${customerId}/portal-sessions`, {
      subscription_ids: [paddleId],
    });

    const urls = session.data.urls;
    const forThis = urls?.subscriptions?.find((s) => s.id === paddleId);
    const url =
      intent === 'update_payment_method'
        ? (forThis?.update_subscription_payment_method ??
          urls?.general?.overview)
        : urls?.general?.overview;

    if (!url) {
      throw new BadRequestException(
        `Paddle returned no portal URL for subscription ${paddleId}.`,
      );
    }
    return { url };
  }

  /**
   * Paddle transactions, read as invoices.
   *
   * Read live rather than from the `invoices` mirror: that mirror is filled by
   * the Stripe webhooks and keyed on `stripe_invoice_id`, so it holds nothing
   * for a Paddle account. The PDF link is NOT fetched here — it needs one
   * extra call per row and expires after an hour, so it is left null and the
   * portal covers the download.
   */
  async listInvoices(
    subscriptionId: number,
    limit: number,
  ): Promise<ProviderInvoice[]> {
    const rows = await this.rowsFor(subscriptionId);
    const base = this.require(rows, 'BASE_PLAN', subscriptionId);
    const paddleId = this.subscriptionIdOf(
      base,
      subscriptionId,
      'list invoices for',
    );

    // Paddle's `per_page` maxes at 30; asking for more is a 400.
    const perPage = Math.max(1, Math.min(limit, 30));
    const res = await this.paddle.get<PaddleEnvelope<PaddleTransaction[]>>(
      `transactions?subscription_id=${encodeURIComponent(
        paddleId,
      )}&per_page=${perPage}`,
    );

    const { planCode } = await this.accountOf(subscriptionId);
    const description = `${await this.catalogue.planName(planCode)} plan`;

    return res.data.map((t) => ({
      id: t.id,
      date: t.billed_at ?? t.created_at,
      description,
      amountCents: Number.parseInt(t.details?.totals?.grand_total ?? '0', 10),
      currency: (t.currency_code ?? 'USD').toUpperCase(),
      status: this.invoiceStatus(t.status),
      downloadUrl: null,
    }));
  }

  /**
   * Paddle does not hand over card details through the API — the portal owns
   * them — so `card` is null and the billing contact comes from the customer
   * record. Null rather than a guess: a wrong last4 on a settings page reads
   * as the wrong card being charged.
   */
  async getBillingProfile(subscriptionId: number): Promise<BillingProfile> {
    const rows = await this.rowsFor(subscriptionId);
    const base = this.require(rows, 'BASE_PLAN', subscriptionId);
    const customerId = base.providerCustomerId;
    if (!customerId) return { card: null, billingDetails: null };

    const res = await this.paddle.get<PaddleEnvelope<PaddleCustomer>>(
      `customers/${customerId}`,
    );
    return {
      card: null,
      billingDetails: {
        name: res.data.name ?? null,
        email: res.data.email ?? null,
        country: null,
      },
    };
  }

  // ------------------------------------------------------------------ shared

  /** Every provider row for one of our subscriptions. */
  private async rowsFor(subscriptionId: number): Promise<ProviderRow[]> {
    const rows = (await this.db
      .select()
      .from(providerSubscriptions)
      .where(
        eq(providerSubscriptions.subscriptionId, subscriptionId),
      )) as ProviderRow[];

    if (rows.length === 0) {
      throw new BadRequestException(
        `Subscription ${subscriptionId} has no provider rows.`,
      );
    }
    return rows;
  }

  /**
   * Scoped to `provider === 'paddle'` deliberately. `rowsFor` returns every
   * provider's rows, and during a migration window two rows can legitimately
   * share an `itemType` — picking by `itemType` alone risks handing a Stripe
   * or Lemon Squeezy id to a Paddle call.
   */
  private require(
    rows: ProviderRow[],
    itemType: ProviderItemType,
    subscriptionId: number,
  ): ProviderRow {
    const row = rows.find(
      (r) => r.itemType === itemType && r.provider === PROVIDER,
    );
    if (!row) {
      throw new BadRequestException(
        `Subscription ${subscriptionId} has no ${PROVIDER} ${itemType} to change.`,
      );
    }
    return row;
  }

  private subscriptionIdOf(
    row: ProviderRow,
    subscriptionId: number,
    verb: string,
  ): string {
    if (!row.providerSubscriptionId) {
      throw new BadRequestException(
        `Subscription ${subscriptionId} has no Paddle subscription to ${verb}.`,
      );
    }
    return row.providerSubscriptionId;
  }

  private priceIdOf(
    row: ProviderRow,
    subscriptionId: number,
    itemType: ProviderItemType,
  ): string {
    if (!row.providerPriceId) {
      throw new BadRequestException(
        `Subscription ${subscriptionId} has no Paddle price recorded for ${itemType}; ` +
          'cannot build the items list without it.',
      );
    }
    return row.providerPriceId;
  }

  private async fetchSubscription(
    paddleId: string,
  ): Promise<PaddleSubscription> {
    const res = await this.paddle.get<PaddleEnvelope<PaddleSubscription>>(
      `subscriptions/${paddleId}`,
    );
    return res.data;
  }

  /**
   * The one place the items array is sent, so the required proration mode
   * cannot be forgotten at a call site.
   */
  private async patchItems(
    paddleId: string,
    items: PaddleItemWrite[],
  ): Promise<void> {
    await this.paddle.patch(`subscriptions/${paddleId}`, {
      items,
      proration_billing_mode: PRORATION,
    });
  }

  private async syncQuantity(rowId: number, quantity: number): Promise<void> {
    await this.db
      .update(providerSubscriptions)
      .set({ providerQuantity: quantity, updatedAt: new Date() })
      .where(eq(providerSubscriptions.id, rowId));
  }

  /**
   * The only item Paddle bills at quantity 1, for a row written before
   * `provider_price_id` was filled. Refuses when that is ambiguous: a wrong
   * answer here swaps an add-on for a plan.
   */
  private soleQuantityOneItem(
    live: PaddleSubscription,
    subscriptionId: number,
  ): string {
    const ones = live.items.filter((i) => i.quantity === 1);
    if (ones.length !== 1) {
      throw new BadRequestException(
        `Subscription ${subscriptionId} has no Paddle price recorded for its base plan, ` +
          'and the live subscription does not identify one unambiguously.',
      );
    }
    return ones[0].price.id;
  }

  /** Paddle transaction status -> our invoice vocabulary. */
  private invoiceStatus(
    status: PaddleTransaction['status'],
  ): ProviderInvoice['status'] {
    switch (status) {
      case 'completed':
      case 'paid':
        return 'paid';
      case 'canceled':
        return 'void';
      case 'past_due':
        return 'failed';
      // `draft`, `ready` and `billed` are all "not settled yet".
      default:
        return 'pending';
    }
  }

  private async accountOf(
    subscriptionId: number,
  ): Promise<{ userId: string; planCode: string }> {
    const rows = (await this.db
      .select({
        userId: subscriptions.userId,
        planCode: subscriptions.planCode,
      })
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))) as {
      userId: string;
      planCode: string;
    }[];

    const row = rows[0];
    if (!row) {
      throw new BadRequestException(
        `Subscription ${subscriptionId} does not exist.`,
      );
    }
    return row;
  }

  /**
   * The Paddle customer for a user: found by email, created when absent.
   *
   * Looked up BEFORE creating, because Paddle's docs do not state what a
   * `POST /customers` for an existing email does — it may conflict or it may
   * create a second record, and a duplicate customer splits one person's
   * billing history across two. The list filter is documented as an exact
   * match and returns `active` customers by default.
   */
  private async customerIdFor(userId: string): Promise<string> {
    const rows = (await this.db
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, userId))) as { email: string; name: string | null }[];
    const user = rows[0];
    if (!user?.email) {
      throw new BadRequestException(
        `User ${userId} has no email address; Paddle needs one to bill.`,
      );
    }

    const found = await this.paddle.get<PaddleEnvelope<PaddleCustomer[]>>(
      `customers?email=${encodeURIComponent(user.email)}`,
    );
    const existing = found.data?.[0]?.id;
    if (existing) return existing;

    const created = await this.paddle.post<PaddleEnvelope<PaddleCustomer>>(
      'customers',
      {
        email: user.email,
        ...(user.name ? { name: user.name } : {}),
        custom_data: { user_id: userId },
      },
    );
    return created.data.id;
  }
}
