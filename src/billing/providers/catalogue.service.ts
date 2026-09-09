import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { DbType } from '../../drizzle/db';
import {
  providerPrices,
  plans,
  addonPricing,
  PaymentProvider,
  ProviderItemType,
} from '../../drizzle/schema';

/**
 * What a plan or add-on is called at a given provider.
 *
 * Stripe reads fall back to the legacy `plans.stripe_price_id` /
 * `addon_pricing.stripe_price_id` columns, so live Stripe billing keeps
 * working before `provider_prices` is populated.
 *
 * Lemon Squeezy has NO fallback on purpose. Those legacy columns hold Stripe
 * price ids; handing one to Lemon Squeezy would fail deep inside their API
 * with an error that says nothing useful. Failing here names the missing row.
 */
@Injectable()
export class CatalogueService {
  constructor(@Inject(DRIZZLE) private db: DbType) {}

  async resolveRef(
    provider: PaymentProvider,
    planCode: string,
    itemType: ProviderItemType,
  ): Promise<string> {
    const rows = await this.db
      .select({ providerRef: providerPrices.providerRef })
      .from(providerPrices)
      .where(
        and(
          eq(providerPrices.provider, provider),
          eq(providerPrices.itemType, itemType),
          eq(providerPrices.planCode, planCode),
          eq(providerPrices.isActive, true),
        ),
      )
      .limit(1);

    const ref = rows[0]?.providerRef;
    if (ref) return ref;

    if (provider === 'stripe') {
      const legacy = await this.legacyStripeRef(planCode, itemType);
      if (legacy) return legacy;
    }

    throw new BadRequestException(
      `A ${provider} price for ${planCode} / ${itemType} is not provisioned. ` +
        `Add a provider_prices row for it.`,
    );
  }

  private async legacyStripeRef(
    planCode: string,
    itemType: ProviderItemType,
  ): Promise<string | null> {
    if (itemType === 'BASE_PLAN') {
      const rows = await this.db
        .select({ stripePriceId: plans.stripePriceId })
        .from(plans)
        .where(eq(plans.code, planCode))
        .limit(1);
      return rows[0]?.stripePriceId ?? null;
    }

    const rows = await this.db
      .select({ stripePriceId: addonPricing.stripePriceId })
      .from(addonPricing)
      .where(
        and(
          eq(addonPricing.planCode, planCode),
          eq(addonPricing.addonType, itemType),
        ),
      )
      .limit(1);
    return rows[0]?.stripePriceId ?? null;
  }
}
