import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { DbType } from '../../drizzle/db';
import {
  providerSubscriptions,
  subscriptions,
  ProviderItemType,
} from '../../drizzle/schema';
import { CatalogueService } from './catalogue.service';
import { LemonSqueezyClient } from './lemonsqueezy.client';
import {
  PROVIDER_ITEM_ORDER,
  PaymentProviderAdapter,
  PurchaseResult,
} from './payment-provider.interface';

const PROVIDER = 'lemonsqueezy' as const;

/** The subset of a `provider_subscriptions` row this adapter acts on. */
interface ProviderRow {
  id: number;
  itemType: string;
  providerSubscriptionId: string | null;
  providerItemId: string | null;
}

/** JSON:API envelope shapes the Lemon Squeezy API answers with. */
interface LsCheckoutResponse {
  data?: { attributes?: { url?: string } };
}
interface LsSubscriptionResponse {
  data?: {
    attributes?: {
      status?: string;
      ends_at?: string | null;
      renews_at?: string | null;
    };
  };
}

/**
 * Lemon Squeezy, expressed as our billing intent.
 *
 * The whole shape of this file follows from one provider limitation: there is
 * no `POST /v1/subscription-items`, and a Lemon Squeezy subscription carries
 * exactly ONE product variant. An account on the Pro plan with three add-ons
 * is therefore FIVE subscriptions, and one logical operation ("cancel this
 * account") fans out into N API calls that can fail halfway.
 *
 * Two rules keep a partial failure survivable, and both are pinned by tests:
 *
 *  1. BASE_PLAN is cancelled LAST (`PROVIDER_ITEM_ORDER`). If the fan-out
 *     breaks midway the customer still holds the plan that runs their service.
 *     Cancelling it first and then failing would end their access while the
 *     add-ons carried on billing.
 *
 *  2. The database is written after EACH successful call, never batched to the
 *     end. A break midway then leaves the rows telling the truth — three
 *     cancelled, two not — which is what reconciliation needs to repair it.
 *     The error is re-thrown, not swallowed.
 */
@Injectable()
export class LemonSqueezyAdapter implements PaymentProviderAdapter {
  readonly name = PROVIDER;

  private readonly logger = new Logger(LemonSqueezyAdapter.name);

  constructor(
    @Inject(DRIZZLE) private db: DbType,
    private readonly client: LemonSqueezyClient,
    private readonly catalogue: CatalogueService,
  ) {}

  // ---------------------------------------------------------------- checkout

  async createCheckout(
    userId: string,
    planCode: string,
    workspaceId: string,
  ): Promise<{ url: string }> {
    // A brand-new account has no existing Lemon Squeezy record to imply a
    // store, so this is the one path where the store id is mandatory. Failing
    // here names the variable; letting it through would fail inside the
    // provider's API with an error that says nothing useful.
    const storeId = process.env.LEMONSQUEEZY_STORE_ID;
    if (!storeId) {
      throw new InternalServerErrorException(
        'LEMONSQUEEZY_STORE_ID is not set; a checkout cannot be created.',
      );
    }

    const variantId = await this.catalogue.resolveRef(
      PROVIDER,
      planCode,
      'BASE_PLAN',
    );
    const url = await this.openCheckout(variantId, 1, {
      user_id: userId,
      workspace_id: workspaceId,
      plan_code: planCode,
      item_type: 'BASE_PLAN',
    });
    return { url };
  }

  // ------------------------------------------------------------------- plan

  async changePlan(subscriptionId: number, newPlanCode: string): Promise<void> {
    const base = await this.requireRow(subscriptionId, 'BASE_PLAN');
    const variantId = await this.catalogue.resolveRef(
      PROVIDER,
      newPlanCode,
      'BASE_PLAN',
    );

    await this.client.patch<LsSubscriptionResponse>(
      `subscriptions/${base.providerSubscriptionId}`,
      {
        data: {
          type: 'subscriptions',
          id: String(base.providerSubscriptionId),
          attributes: {
            variant_id: Number(variantId),
            invoice_immediately: true,
          },
        },
      },
    );

    await this.db
      .update(providerSubscriptions)
      .set({ providerPriceId: variantId, updatedAt: new Date() })
      .where(eq(providerSubscriptions.id, base.id));
  }

  // ----------------------------------------------------------------- add-ons

  /**
   * There is no endpoint that creates a subscription, so an add-on the account
   * does not already hold can only START at a hosted checkout — it completes
   * later, over a webhook. An add-on it does hold is a quantity change on the
   * existing subscription item, which finishes synchronously.
   */
  async purchaseAddon(
    subscriptionId: number,
    itemType: ProviderItemType,
    quantity: number,
  ): Promise<PurchaseResult> {
    const existing = await this.findRow(subscriptionId, itemType);

    if (existing) {
      await this.changeAddonQuantity(subscriptionId, itemType, quantity);
      return { status: 'completed', quantity };
    }

    const { userId, planCode } = await this.accountOf(subscriptionId);
    const variantId = await this.catalogue.resolveRef(
      PROVIDER,
      planCode,
      itemType,
    );
    const url = await this.openCheckout(variantId, quantity, {
      user_id: userId,
      subscription_id: String(subscriptionId),
      plan_code: planCode,
      item_type: itemType,
    });

    return { status: 'checkout_required', url };
  }

  /**
   * Verified live 2026-09-07: `invoice_immediately` charges the difference at
   * once and does NOT move `renews_at`. Without it the customer gets the extra
   * capacity now and is billed for it only at renewal. Note the path is keyed
   * on the ITEM id, not the subscription id.
   */
  async changeAddonQuantity(
    subscriptionId: number,
    itemType: ProviderItemType,
    quantity: number,
  ): Promise<void> {
    const row = await this.requireRow(subscriptionId, itemType);

    await this.client.patch<LsSubscriptionResponse>(
      `subscription-items/${row.providerItemId}`,
      {
        data: {
          type: 'subscription-items',
          id: String(row.providerItemId),
          attributes: { quantity, invoice_immediately: true },
        },
      },
    );

    await this.db
      .update(providerSubscriptions)
      .set({ providerQuantity: quantity, updatedAt: new Date() })
      .where(eq(providerSubscriptions.id, row.id));
  }

  /**
   * An add-on IS a whole subscription here, so removing it cancels that
   * subscription rather than deleting a line item. `cancelled` does not revoke
   * anything — the add-on runs to its own `ends_at`.
   */
  async removeAddon(
    subscriptionId: number,
    itemType: ProviderItemType,
  ): Promise<void> {
    const row = await this.requireRow(subscriptionId, itemType);
    const res = await this.client.delete<LsSubscriptionResponse>(
      `subscriptions/${row.providerSubscriptionId}`,
    );
    await this.recordCancelled(row, res);
  }

  // ------------------------------------------------------------------ cancel

  /**
   * The dangerous one. Iterating `PROVIDER_ITEM_ORDER` — never `Promise.all`,
   * never the row order the database happened to return — is what puts
   * BASE_PLAN last. Each success is written to the database before the next
   * call is made, and a failure propagates untouched so everything after it
   * (including the base plan) is left alive and correct in both systems.
   *
   * `atPeriodEnd` is accepted for interface parity but cannot be honoured
   * here: Lemon Squeezy has no immediate-revoke endpoint. `DELETE` always
   * yields `cancelled`, which runs to `ends_at` — i.e. always at period end.
   * An immediate cancellation is logged rather than silently downgraded, so
   * the divergence from the caller's intent is visible.
   */
  async cancel(subscriptionId: number, atPeriodEnd: boolean): Promise<void> {
    if (!atPeriodEnd) {
      this.logger.warn(
        `Immediate cancellation was requested for subscription ${subscriptionId}, ` +
          `but Lemon Squeezy only cancels at period end; it will run to ends_at.`,
      );
    }

    const rows = await this.rowsFor(subscriptionId);
    const byType = new Map(rows.map((r) => [r.itemType, r]));

    for (const itemType of PROVIDER_ITEM_ORDER) {
      const row = byType.get(itemType);
      if (!row?.providerSubscriptionId) continue;

      const res = await this.client.delete<LsSubscriptionResponse>(
        `subscriptions/${row.providerSubscriptionId}`,
      );
      // Immediately, one row at a time. Batching these to the end would leave
      // every row wrong the moment a later call throws.
      await this.recordCancelled(row, res);
    }
  }

  // ------------------------------------------------------------ pause/resume

  /**
   * `void` rather than `keep_as_draft`: a returning customer must not be
   * handed a stack of back-invoices for the months they were paused.
   *
   * Every row is paused, add-ons included — pausing only the base plan would
   * leave the add-ons billing a customer who is using nothing.
   */
  async pause(subscriptionId: number): Promise<void> {
    await this.setPause(subscriptionId, { mode: 'void' });
  }

  async resume(subscriptionId: number): Promise<void> {
    await this.setPause(subscriptionId, null);
  }

  private async setPause(
    subscriptionId: number,
    pause: { mode: string } | null,
  ): Promise<void> {
    const rows = await this.rowsFor(subscriptionId);
    const byType = new Map(rows.map((r) => [r.itemType, r]));

    for (const itemType of PROVIDER_ITEM_ORDER) {
      const row = byType.get(itemType);
      if (!row?.providerSubscriptionId) continue;

      const res = await this.client.patch<LsSubscriptionResponse>(
        `subscriptions/${row.providerSubscriptionId}`,
        {
          data: {
            type: 'subscriptions',
            id: String(row.providerSubscriptionId),
            attributes: { pause },
          },
        },
      );

      await this.db
        .update(providerSubscriptions)
        .set({
          providerStatus: res?.data?.attributes?.status ?? null,
          updatedAt: new Date(),
        })
        .where(eq(providerSubscriptions.id, row.id));
    }
  }

  // ------------------------------------------------------------------ shared

  /** Every Lemon Squeezy row for one of our subscriptions. */
  private async rowsFor(subscriptionId: number): Promise<ProviderRow[]> {
    const rows = await this.db
      .select({
        id: providerSubscriptions.id,
        itemType: providerSubscriptions.itemType,
        providerSubscriptionId: providerSubscriptions.providerSubscriptionId,
        providerItemId: providerSubscriptions.providerItemId,
      })
      .from(providerSubscriptions)
      .where(
        and(
          eq(providerSubscriptions.subscriptionId, subscriptionId),
          eq(providerSubscriptions.provider, PROVIDER),
        ),
      );

    return rows as ProviderRow[];
  }

  private async findRow(
    subscriptionId: number,
    itemType: ProviderItemType,
  ): Promise<ProviderRow | undefined> {
    const rows = await this.rowsFor(subscriptionId);
    return rows.find((r) => r.itemType === itemType);
  }

  /** Naming the item type matters: "not found" alone says nothing actionable. */
  private async requireRow(
    subscriptionId: number,
    itemType: ProviderItemType,
  ): Promise<ProviderRow> {
    const row = await this.findRow(subscriptionId, itemType);
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

  /**
   * `cancelled` is kept raw. Lemon Squeezy's `cancelled` means access
   * CONTINUES until `ends_at`; mapping it here would revoke early.
   */
  private async recordCancelled(
    row: ProviderRow,
    res: LsSubscriptionResponse,
  ): Promise<void> {
    const attrs = res?.data?.attributes ?? {};
    await this.db
      .update(providerSubscriptions)
      .set({
        providerStatus: attrs.status ?? 'cancelled',
        endsAt: attrs.ends_at ? new Date(attrs.ends_at) : null,
        renewsAt: attrs.renews_at ? new Date(attrs.renews_at) : null,
        updatedAt: new Date(),
      })
      .where(eq(providerSubscriptions.id, row.id));
  }

  private async openCheckout(
    variantId: string,
    quantity: number,
    custom: Record<string, string>,
  ): Promise<string> {
    const storeId = process.env.LEMONSQUEEZY_STORE_ID;

    const relationships: Record<string, unknown> = {
      variant: { data: { type: 'variants', id: String(variantId) } },
    };
    // An add-on checkout runs against an account that already has Lemon
    // Squeezy records, so the store is implied; only a first-ever checkout
    // hard-requires it, and `createCheckout` guards that itself.
    if (storeId) {
      relationships.store = { data: { type: 'stores', id: String(storeId) } };
    }

    const res = await this.client.post<LsCheckoutResponse>('checkouts', {
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: {
            custom,
            variant_quantities: [{ variant_id: Number(variantId), quantity }],
          },
        },
        relationships,
      },
    });

    const url = res?.data?.attributes?.url;
    if (!url) {
      this.logger.error(
        `Lemon Squeezy returned no checkout url for variant ${variantId}.`,
      );
      throw new InternalServerErrorException(
        'Lemon Squeezy did not return a checkout url.',
      );
    }
    return url;
  }
}
