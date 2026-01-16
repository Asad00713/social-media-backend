import { Module } from '@nestjs/common';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { CustomerService } from './services/customer.service';
import { SubscriptionService } from './services/subscription.service';
import { WebhookService } from './services/webhook.service';
import { UsageService } from './services/usage.service';
import { AddonService } from './services/addon.service';
import { PlanChangeService } from './services/plan-change.service';
import { DashboardService } from './services/dashboard.service';
import { InvoiceService } from './services/invoice.service';
import { PaymentMethodService } from './services/payment-method.service';
import { StripeModule } from '../stripe/stripe.module';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [StripeModule, DrizzleModule, NotificationsModule],
  providers: [
    BillingService,
    CustomerService,
    SubscriptionService,
    WebhookService,
    UsageService,
    AddonService,
    PlanChangeService,
    DashboardService,
    InvoiceService,
    PaymentMethodService,
  ],
  controllers: [BillingController],
  exports: [CustomerService, SubscriptionService, WebhookService, UsageService, AddonService, PlanChangeService, DashboardService, InvoiceService, PaymentMethodService],
})
export class BillingModule {}
