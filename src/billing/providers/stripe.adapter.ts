import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { DbType } from '../../drizzle/db';
import {
  invoiceLineItems,
  invoices,
  paymentMethods,
  providerSubscriptions,
  stripeCustomers,
  subscriptions,
  users,
  workspace,
  ProviderItemType,
} from '../../drizzle/schema';
import { AppLinks } from '../../email/links/app-links';
import { CatalogueService } from './catalogue.service';
import { CustomerService } from '../services/customer.service';
import { StripeService } from '../../stripe/stripe.service';
import { assertProviderIsStripe } from '../../stripe/stripe-guard.util';
import { pickDefaultProvider } from '../services/provider-subscription.util';
import { rehomeDefault } from '../services/rehome-default.util';
import {
  BillingProfile,
  PaymentProviderAdapter,
  PortalIntent,
  ProviderInvoice,
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
    private readonly links: AppLinks,
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

    if (!base.providerItemId || !base.providerSubscriptionId) {
      throw new BadRequestException(
        `Subscription ${subscriptionId} has no Stripe line item for its base plan.`,
      );
    }

    // `updateSubscriptionItem` cannot change price — Stripe's subscription
    // item update endpoint takes no `price` field, only `quantity`. Changing
    // the plan means changing the PRICE the item points at, which is a
    // subscription-level call (`items: [{ id, price }]`), the same shape the
    // legacy `plan-change.service.ts` already uses. `proration_behavior:
    // 'none'` mirrors that legacy call: a plan change is a scheduled swap of
    // what the customer is on, not a mid-cycle charge/credit event here.
    await this.stripe.updateSubscription(base.providerSubscriptionId, {
      items: [{ id: base.providerItemId, price: priceId }],
      proration_behavior: 'none',
    });

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
    // `rowsFor` deliberately returns every provider's rows so the Task 6
    // guard can see a foreign default row. During the LS -> Stripe migration
    // window an account can hold BOTH a Lemon Squeezy and a Stripe row for
    // the same item type at once — this filter is what keeps that foreign
    // row's id from being handed to a Stripe API call.
    const existing = rows.find(
      (r) => r.itemType === itemType && r.provider === PROVIDER,
    );

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

    // `isDefault` is FALSE here, and that is not a detail.
    //
    // The flag marks the account's default PROVIDER, not its default item — a
    // property of the account, carried by exactly one row. `0032` enforces
    // that with a partial unique index (`... ON provider_subscriptions
    // (subscription_id) WHERE is_default`), so setting it on every add-on
    // insert meant an account that already had one — every Stripe account,
    // whose BASE_PLAN row carries it — hit a 23505 unique violation AFTER
    // `addSubscriptionItem` had already put the billable line on the
    // subscription: the customer was charged, the request 500'd, and no
    // bookkeeping row was written.
    //
    // It was also wrong when it did land. `pickDefaultProvider` returns the
    // provider of whichever row holds the flag, so the "scoped to the default
    // provider" invariant that `findItem` and `hasLiveBasePlan` rest on would
    // have depended on insert order.
    //
    // The BASE_PLAN row is what carries the flag, written by
    // `writeStripeBasePlanRow` (and backfilled by `0034`) — and `require()`
    // above has already proved it exists, since an add-on cannot be added to a
    // subscription we hold no base plan for.
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
        isDefault: false,
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

    // `canceled`, NOT `removed`. `isLive` is a DENY-LIST — it fails open by
    // design, so a status it does not recognise reads as STILL BILLING.
    // `removed` was such a status, which meant a deleted Stripe line item went
    // on reading as live: it fed `billedQuantities` and, worse, it was
    // eligible to inherit `is_default` in `rehomeDefault`'s heir search, so a
    // removed add-on could become the row that makes an unbilled account read
    // as paying. This is the liveness-write-that-never-touches-the-flag shape
    // that broke the invariant twice before on this branch.
    //
    // Chose the existing vocabulary over widening the deny-list at the source:
    // `endStripeProviderRows` already writes `canceled` for the same meaning
    // ("this is over at the provider"), one spelling per fact is what stops
    // the next status from drifting out of the deny-list the same way, and it
    // needs no new entry to be correct. `removed` is ALSO added to
    // `STRIPE_TERMINAL_STATUSES` so rows already written that way — this code
    // has shipped nowhere yet, but a local or staging database may hold them —
    // read correctly rather than staying live forever.
    await this.db
      .update(providerSubscriptions)
      .set({
        providerStatus: 'canceled',
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

    // An immediate cancel (atPeriodEnd=false) is genuine termination — the
    // same shape endStripeProviderRows exists for. It must drop is_default,
    // not just keep it the way expireStripeProviderRows does for stale-id
    // recovery: this account isn't expected to re-subscribe through Stripe
    // immediately, so the flag must free the single slot
    // provider_subscriptions_one_default_idx allows, or a later Lemon Squeezy
    // signup raises 23505 after LS has already taken the payment. The
    // subscription.deleted webhook (endStripeProviderRows) self-heals this
    // shortly after, so the gap this closes is only the window before that
    // webhook lands.
    //
    // A scheduled cancel (atPeriodEnd=true) is still billing until the period
    // ends, so it must keep is_default exactly like `cancel_scheduled` already
    // implies.
    await this.db
      .update(providerSubscriptions)
      .set({
        providerStatus: atPeriodEnd ? 'cancel_scheduled' : 'canceled',
        ...(atPeriodEnd ? {} : { isDefault: false }),
        updatedAt: new Date(),
      })
      .where(eq(providerSubscriptions.id, base.id));

    // Releasing the flag is only half of it. `is_default` names the provider
    // billing THE ACCOUNT, not this row, and mid-cutover a live Lemon Squeezy
    // row can survive an immediate Stripe cancel untouched — this UPDATE
    // touches one Stripe row. Leaving zero defaults on an account Lemon
    // Squeezy is still charging makes `hasLiveBasePlan` answer false for a
    // paying customer and opens a SECOND subscription through the FREE->paid
    // branch. Runs AFTER the write above so the row just cancelled is already
    // not-live and cannot win its own heir search.
    if (!atPeriodEnd) {
      await rehomeDefault({
        subscriptionId,
        excludeRowId: base.id,
        // The INJECTED handle, not the module-level one — see the helper's
        // doc comment. They are the same instance at runtime and different
        // fakes under test.
        db: this.db,
      });
    }
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

  // ------------------------------------------------- portal, invoices, profile

  /**
   * A one-shot Stripe billing-portal session. The customer comes back to the
   * billing settings of the workspace the caller names (`opts.workspaceId`, the
   * route's guard-validated one), else the one they were last in, so the portal
   * never strands them on a Stripe page.
   * `update_payment_method` opens the card form directly (`flow_data`), skipping
   * the portal's home screen.
   */
  async createPortalLink(
    subscriptionId: number,
    intent: PortalIntent,
    opts?: { workspaceId?: string },
  ): Promise<{ url: string }> {
    await this.rowsFor(subscriptionId);
    const { userId } = await this.accountOf(subscriptionId);
    const customer = await this.customerOf(userId);
    if (!customer) {
      throw new BadRequestException(
        `Subscription ${subscriptionId} has no Stripe customer to open a portal for.`,
      );
    }

    const session = await this.stripe
      .getClient()
      .billingPortal.sessions.create({
        customer,
        return_url: opts?.workspaceId
          ? this.links.billing(opts.workspaceId)
          : await this.billingReturnUrl(userId),
        ...(intent === 'update_payment_method'
          ? { flow_data: { type: 'payment_method_update' as const } }
          : {}),
      });
    return { url: session.url };
  }

  /**
   * Read from the `invoices` mirror the webhooks keep, so listing costs no
   * Stripe call. The mirror stores no refund state and no line description of
   * its own: a refund still reads `paid`, and the description is the first
   * line item's, else the account's plan name.
   */
  async listInvoices(
    subscriptionId: number,
    limit: number,
  ): Promise<ProviderInvoice[]> {
    await this.rowsFor(subscriptionId);

    const rows = await this.db
      .select()
      .from(invoices)
      .where(eq(invoices.subscriptionId, subscriptionId))
      .orderBy(desc(invoices.createdAt), desc(invoices.id))
      .limit(limit);
    if (rows.length === 0) return [];

    const lines = await this.db
      .select({
        invoiceId: invoiceLineItems.invoiceId,
        description: invoiceLineItems.description,
      })
      .from(invoiceLineItems)
      .where(
        inArray(
          invoiceLineItems.invoiceId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(asc(invoiceLineItems.id));
    const firstLine = new Map<number, string>();
    for (const line of lines) {
      if (!firstLine.has(line.invoiceId))
        firstLine.set(line.invoiceId, line.description);
    }

    const { planCode } = await this.accountOf(subscriptionId);
    const fallback = `${await this.catalogue.planName(planCode)} plan`;

    return rows.map((r) => ({
      id: r.stripeInvoiceId,
      date: (r.paidAt ?? r.createdAt).toISOString(),
      description: firstLine.get(r.id) ?? fallback,
      amountCents: r.totalCents,
      currency: r.currency.toUpperCase(),
      status: this.invoiceStatus(r.status),
      downloadUrl: r.invoicePdfUrl ?? r.hostedInvoiceUrl ?? null,
    }));
  }

  /**
   * The default card from the `payment_methods` mirror (else the newest one).
   * Stripe's customer name/email/country are not mirrored, so `billingDetails`
   * is null rather than a call to Stripe from a read-only settings screen.
   */
  async getBillingProfile(subscriptionId: number): Promise<BillingProfile> {
    await this.rowsFor(subscriptionId);
    const { userId } = await this.accountOf(subscriptionId);
    const customer = await this.customerOf(userId);
    if (!customer) return { card: null, billingDetails: null };

    const methods = await this.db
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.stripeCustomerId, customer))
      .orderBy(desc(paymentMethods.isDefault), desc(paymentMethods.createdAt));

    const method = methods[0];
    return {
      card: method
        ? { brand: method.cardBrand ?? null, last4: method.cardLast4 ?? null }
        : null,
      billingDetails: null,
    };
  }

  /** `uncollectible` is Stripe giving up on a charge: that is a failed one. */
  private invoiceStatus(status: string): ProviderInvoice['status'] {
    switch (status) {
      case 'paid':
        return 'paid';
      case 'void':
        return 'void';
      case 'uncollectible':
        return 'failed';
      default:
        return 'pending';
    }
  }

  private async customerOf(userId: string): Promise<string | null> {
    const rows = await this.db
      .select({ id: stripeCustomers.stripeCustomerId })
      .from(stripeCustomers)
      .where(eq(stripeCustomers.userId, userId))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  /**
   * Billing settings of the workspace the person last opened, else the first
   * they own, else the app root. A subscription belongs to the account, not to
   * a workspace, so there is no single "right" one.
   */
  private async billingReturnUrl(userId: string): Promise<string> {
    const [last] = await this.db
      .select({ id: workspace.id })
      .from(users)
      .innerJoin(workspace, eq(workspace.id, users.lastAccessedWorkspaceId))
      .where(eq(users.id, userId))
      .limit(1);
    if (last) return this.links.billing(last.id);

    const [owned] = await this.db
      .select({ id: workspace.id })
      .from(workspace)
      .where(eq(workspace.ownerId, userId))
      .orderBy(asc(workspace.createdAt), asc(workspace.id))
      .limit(1);
    return owned ? this.links.billing(owned.id) : this.links.frontend('/');
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

  /**
   * Naming the item type matters: "not found" alone says nothing actionable.
   *
   * Scoped to `provider === 'stripe'` deliberately — `rows` here is
   * `rowsFor`'s full, unfiltered result (every provider, so the Task 6 guard
   * can inspect the default row). During the LS -> Stripe migration window
   * two rows can legitimately share an `itemType`, and picking one by
   * `itemType` alone risks handing a Lemon Squeezy id to a Stripe call. This
   * mirrors `findItem` in `provider-subscription.util.ts`, which scopes to
   * the default provider for exactly this reason.
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
