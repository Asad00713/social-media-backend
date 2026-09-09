import { Module } from '@nestjs/common';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { CustomerService } from './services/customer.service';
import { SubscriptionService } from './services/subscription.service';
import { WebhookService } from './services/webhook.service';
import { LemonSqueezyWebhookService } from './services/lemonsqueezy-webhook.service';
import { UsageService } from './services/usage.service';
import { AddonService } from './services/addon.service';
import { PlanChangeService } from './services/plan-change.service';
import { DashboardService } from './services/dashboard.service';
import { InvoiceService } from './services/invoice.service';
import { PaymentMethodService } from './services/payment-method.service';
import { SubscriptionLookupService } from './services/subscription-lookup.service';
import { AccountChannelsService } from './services/account-channels.service';
import { PostQueueService } from './services/post-queue.service';
import { StripeModule } from '../stripe/stripe.module';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProviderRegistryService } from './providers/provider-registry.service';
import { CatalogueService } from './providers/catalogue.service';
import { LemonSqueezyClient } from './providers/lemonsqueezy.client';
import { StripeAdapter } from './providers/stripe.adapter';
import { LemonSqueezyAdapter } from './providers/lemonsqueezy.adapter';

/**
 * Adapters announce themselves to the registry at boot instead of being
 * injected into it.
 *
 * Injecting them would invert the dependency the wrong way: the registry would
 * have to import every adapter, each adapter already depends on the catalogue
 * and its own client, and adding a third provider would mean editing the
 * registry. Nest resolves this factory only after both adapters are
 * constructed, so the map is complete before the first request.
 */
const PROVIDER_ADAPTER_REGISTRATION = {
  provide: 'PROVIDER_ADAPTER_REGISTRATION',
  inject: [ProviderRegistryService, StripeAdapter, LemonSqueezyAdapter],
  useFactory: (
    registry: ProviderRegistryService,
    stripe: StripeAdapter,
    lemonsqueezy: LemonSqueezyAdapter,
  ): true => {
    registry.register(stripe);
    registry.register(lemonsqueezy);
    return true;
  },
};

@Module({
  imports: [StripeModule, DrizzleModule, NotificationsModule],
  providers: [
    BillingService,
    CustomerService,
    SubscriptionService,
    WebhookService,
    LemonSqueezyWebhookService,
    UsageService,
    AddonService,
    PlanChangeService,
    DashboardService,
    InvoiceService,
    PaymentMethodService,
    SubscriptionLookupService,
    PostQueueService,
    AccountChannelsService,
    ProviderRegistryService,
    CatalogueService,
    LemonSqueezyClient,
    StripeAdapter,
    LemonSqueezyAdapter,
    PROVIDER_ADAPTER_REGISTRATION,
  ],
  controllers: [BillingController],
  exports: [
    CustomerService,
    SubscriptionService,
    WebhookService,
    LemonSqueezyWebhookService,
    UsageService,
    AddonService,
    PlanChangeService,
    DashboardService,
    InvoiceService,
    PaymentMethodService,
    SubscriptionLookupService,
    PostQueueService,
    AccountChannelsService,
    ProviderRegistryService,
    CatalogueService,
    StripeAdapter,
    LemonSqueezyAdapter,
  ],
})
export class BillingModule {}
