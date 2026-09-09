import {
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { DbType } from '../../drizzle/db';
import {
  providerSubscriptions,
  subscriptions,
  PaymentProvider,
  PAYMENT_PROVIDERS,
} from '../../drizzle/schema';
import { pickDefaultProvider } from '../services/provider-subscription.util';
import type { PaymentProviderAdapter } from './payment-provider.interface';

/**
 * Which payment provider an account bills through.
 *
 * One rule, in one place: an EXISTING customer's own `is_default` row decides,
 * and only a brand-new account falls back to the configured default. That is
 * what makes the Lemon Squeezy -> Stripe migration safe — flipping the env var
 * sends new signups to Stripe without moving anybody who is mid-period.
 */
@Injectable()
export class ProviderRegistryService {
  constructor(@Inject(DRIZZLE) private db: DbType) {}

  /**
   * Adapters register themselves at module boot (see `BillingModule`) rather
   * than being injected here. Injecting them would make this service depend on
   * every adapter, and each adapter already depends on catalogue/client
   * services — a cycle waiting to happen, and a new provider could not be
   * added without editing the registry.
   */
  private readonly adapters = new Map<
    PaymentProvider,
    PaymentProviderAdapter
  >();

  register(adapter: PaymentProviderAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  private adapterOf(provider: PaymentProvider): PaymentProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new InternalServerErrorException(
        `No adapter is registered for provider "${provider}".`,
      );
    }
    return adapter;
  }

  /**
   * The adapter that must handle a call made on behalf of an ACCOUNT — the
   * signup/checkout path, where no subscription row exists yet.
   */
  async adapterFor(userId: string): Promise<PaymentProviderAdapter> {
    return this.adapterOf(await this.providerForUser(userId));
  }

  /**
   * The adapter that must handle a call against an EXISTING subscription.
   *
   * Falls back to the configured provider only when the subscription has no
   * `provider_subscriptions` row at all (a legacy row predating this table).
   */
  async adapterForSubscription(
    subscriptionId: number,
  ): Promise<PaymentProviderAdapter> {
    const provider =
      (await this.defaultProviderFor(subscriptionId)) ??
      this.configuredProvider();
    return this.adapterOf(provider);
  }

  /**
   * The provider new accounts are signed up with.
   *
   * NOT defaulted to Stripe. Hardcoding Stripe would reintroduce the silent-
   * Stripe problem this design exists to prevent: any account whose provider
   * row failed to write would quietly bill through Stripe.
   */
  configuredProvider(): PaymentProvider {
    const raw = process.env.BILLING_PROVIDER ?? 'lemonsqueezy';
    if (!(PAYMENT_PROVIDERS as readonly string[]).includes(raw)) {
      throw new InternalServerErrorException(
        `BILLING_PROVIDER is "${raw}", which is not a known provider ` +
          `(${PAYMENT_PROVIDERS.join(', ')}).`,
      );
    }
    return raw as PaymentProvider;
  }

  /** The provider billing one of our subscriptions, or null if it has none. */
  async defaultProviderFor(
    subscriptionId: number,
  ): Promise<PaymentProvider | null> {
    const rows = await this.db
      .select()
      .from(providerSubscriptions)
      .where(eq(providerSubscriptions.subscriptionId, subscriptionId));
    return pickDefaultProvider(rows as never);
  }

  /** The provider billing an account, falling back for a new one. */
  async providerForUser(userId: string): Promise<PaymentProvider> {
    const rows = await this.db
      .select({
        provider: providerSubscriptions.provider,
        isDefault: providerSubscriptions.isDefault,
      })
      .from(providerSubscriptions)
      .innerJoin(
        subscriptions,
        eq(subscriptions.id, providerSubscriptions.subscriptionId),
      )
      .where(eq(subscriptions.userId, userId));

    return pickDefaultProvider(rows as never) ?? this.configuredProvider();
  }
}
