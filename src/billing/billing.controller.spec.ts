import { Test, TestingModule } from '@nestjs/testing';
import { BillingController } from './billing.controller';
import { SubscriptionService } from './services/subscription.service';
import { WebhookService } from './services/webhook.service';
import { LemonSqueezyWebhookService } from './services/lemonsqueezy-webhook.service';
import { PaddleWebhookService } from './services/paddle-webhook.service';
import { UsageService } from './services/usage.service';
import { AddonService } from './services/addon.service';
import { PlanChangeService } from './services/plan-change.service';
import { DashboardService } from './services/dashboard.service';
import { InvoiceService } from './services/invoice.service';
import { BillingOverviewService } from './services/billing-overview.service';
import { PaymentMethodService } from './services/payment-method.service';
import { StripeService } from '../stripe/stripe.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';

const STUBBED_SERVICES = [
  SubscriptionService,
  WebhookService,
  LemonSqueezyWebhookService,
  PaddleWebhookService,
  UsageService,
  AddonService,
  PlanChangeService,
  DashboardService,
  InvoiceService,
  PaymentMethodService,
  StripeService,
];

describe('BillingController', () => {
  let controller: BillingController;
  const overview = {
    overview: jest.fn().mockResolvedValue({ status: 'free' }),
    invoices: jest.fn().mockResolvedValue({ invoices: [] }),
    portalLink: jest.fn().mockResolvedValue({ url: 'https://p.test/x' }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    // Every collaborator is a stub and both guards are overridden: this spec
    // is about the controller's own wiring, not the guards' dependencies
    // (WorkspaceRoleGuard needs WorkspaceRoleService, which its own specs and
    // every-workspace-route-guarded.spec.ts cover).
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BillingController],
      providers: [
        ...STUBBED_SERVICES.map((provide) => ({ provide, useValue: {} })),
        { provide: BillingOverviewService, useValue: overview },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(WorkspaceRoleGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<BillingController>(BillingController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('settings billing endpoints', () => {
    it('GET overview asks for the route workspace', async () => {
      await expect(controller.getBillingOverview('ws-1')).resolves.toEqual({
        status: 'free',
      });
      expect(overview.overview).toHaveBeenCalledWith('ws-1');
    });

    it('GET invoices/provider passes the limit through as a number', async () => {
      await controller.getProviderInvoices('ws-1', '50');
      expect(overview.invoices).toHaveBeenCalledWith('ws-1', 50);
    });

    it('GET invoices/provider leaves the default to the service when no limit is sent', async () => {
      await controller.getProviderInvoices('ws-1');
      expect(overview.invoices).toHaveBeenCalledWith('ws-1', undefined);
    });

    it('POST portal-link passes the route workspace and the intent', async () => {
      await expect(
        controller.createPortalLink('ws-1', {
          intent: 'update_payment_method',
        }),
      ).resolves.toEqual({ url: 'https://p.test/x' });
      expect(overview.portalLink).toHaveBeenCalledWith(
        'ws-1',
        'update_payment_method',
      );
    });
  });
});
