import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import {
  Controller,
  Post,
  Delete,
  Get,
  Body,
  Param,
  Query,
  Req,
  Headers,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { SubscriptionService } from './services/subscription.service';
import { WebhookService } from './services/webhook.service';
import { UsageService } from './services/usage.service';
import { AddonService } from './services/addon.service';
import { PlanChangeService } from './services/plan-change.service';
import { DashboardService } from './services/dashboard.service';
import { InvoiceService } from './services/invoice.service';
import { PaymentMethodService } from './services/payment-method.service';
import { StripeService } from '../stripe/stripe.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller('billing')
export class BillingController {
  constructor(
    private subscriptionService: SubscriptionService,
    private webhookService: WebhookService,
    private usageService: UsageService,
    private addonService: AddonService,
    private planChangeService: PlanChangeService,
    private dashboardService: DashboardService,
    private invoiceService: InvoiceService,
    private paymentMethodService: PaymentMethodService,
    private stripeService: StripeService,
  ) {}

  @Post('workspaces/:workspaceId/subscription')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async createSubscription(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body()
    body: {
      planCode: string;
      paymentMethodId?: string;
      trialPeriodDays?: number;
    },
  ) {
    return await this.subscriptionService.createSubscription({
      workspaceId,
      userId: user.userId,
      planCode: body.planCode,
      paymentMethodId: body.paymentMethodId,
      trialPeriodDays: body.trialPeriodDays,
    });
  }

  @Get('workspaces/:workspaceId/subscription')
  @UseGuards(JwtAuthGuard)
  async getSubscription(@Param('workspaceId') workspaceId: string) {
    return await this.subscriptionService.getSubscriptionByWorkspaceId(
      workspaceId,
    );
  }

  @Delete('workspaces/:workspaceId/subscription')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async cancelSubscription(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body() body: { cancelAtPeriodEnd?: boolean },
  ) {
    return await this.subscriptionService.cancelSubscription(
      workspaceId,
      user.userId,
      body.cancelAtPeriodEnd ?? true,
    );
  }

  // Usage endpoints
  @Get('workspaces/:workspaceId/usage')
  @UseGuards(JwtAuthGuard)
  async getWorkspaceUsage(@Param('workspaceId') workspaceId: string) {
    return await this.usageService.getWorkspaceUsage(workspaceId);
  }

  @Get('users/workspace-limits')
  @UseGuards(JwtAuthGuard)
  async getUserWorkspaceLimits(
    @CurrentUser() user: { userId: string; email: string },
  ) {
    return await this.usageService.getWorkspaceLimits(user.userId);
  }

  @Post('workspaces/:workspaceId/usage/recalculate')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async recalculateUsage(@Param('workspaceId') workspaceId: string) {
    await this.usageService.recalculateWorkspaceUsage(workspaceId);
    return { message: 'Usage recalculated successfully' };
  }

  // Add-on endpoints
  @Get('workspaces/:workspaceId/addons')
  @UseGuards(JwtAuthGuard)
  async getAvailableAddons(@Param('workspaceId') workspaceId: string) {
    return await this.addonService.getAvailableAddons(workspaceId);
  }

  @Get('workspaces/:workspaceId/addons/current')
  @UseGuards(JwtAuthGuard)
  async getCurrentAddons(@Param('workspaceId') workspaceId: string) {
    return await this.addonService.getCurrentAddons(workspaceId);
  }

  @Post('workspaces/:workspaceId/addons')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async purchaseAddon(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body() body: { addonType: 'EXTRA_CHANNEL' | 'EXTRA_MEMBER' | 'EXTRA_WORKSPACE'; quantity: number },
  ) {
    return await this.addonService.purchaseAddon({
      workspaceId,
      userId: user.userId,
      addonType: body.addonType,
      quantity: body.quantity,
    });
  }

  @Delete('workspaces/:workspaceId/addons/:addonType')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async removeAddon(
    @Param('workspaceId') workspaceId: string,
    @Param('addonType') addonType: 'EXTRA_CHANNEL' | 'EXTRA_MEMBER' | 'EXTRA_WORKSPACE',
    @CurrentUser() user: { userId: string; email: string },
    @Body() body: { quantity?: number },
  ) {
    return await this.addonService.removeAddon(
      workspaceId,
      user.userId,
      addonType,
      body.quantity,
    );
  }

  // Plan endpoints
  @Get('plans')
  async getAllPlans() {
    // Public endpoint - returns all available plans without workspace context
    return await this.planChangeService.getAllPlans();
  }

  @Get('workspaces/:workspaceId/plans')
  @UseGuards(JwtAuthGuard)
  async getPlansForWorkspace(@Param('workspaceId') workspaceId: string) {
    return await this.planChangeService.getAvailablePlans(workspaceId);
  }

  @Get('workspaces/:workspaceId/plan-change/preview')
  @UseGuards(JwtAuthGuard)
  async previewPlanChange(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Query('newPlanCode') newPlanCode: string,
  ) {
    return await this.planChangeService.previewPlanChange(
      workspaceId,
      user.userId,
      newPlanCode,
    );
  }

  @Post('workspaces/:workspaceId/plan-change')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async changePlan(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body() body: { newPlanCode: string },
  ) {
    return await this.planChangeService.changePlan(
      workspaceId,
      user.userId,
      body.newPlanCode,
    );
  }

  @Post('workspaces/:workspaceId/downgrade-to-free')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async downgradeToFree(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
  ) {
    return await this.planChangeService.downgradeToFree(workspaceId, user.userId);
  }

  // Dashboard endpoints
  @Get('workspaces/:workspaceId/dashboard')
  @UseGuards(JwtAuthGuard)
  async getWorkspaceDashboard(@Param('workspaceId') workspaceId: string) {
    return await this.dashboardService.getWorkspaceDashboard(workspaceId);
  }

  @Get('users/billing-summary')
  @UseGuards(JwtAuthGuard)
  async getUserBillingSummary(
    @CurrentUser() user: { userId: string; email: string },
  ) {
    return await this.dashboardService.getUserBillingSummary(user.userId);
  }

  @Get('workspaces/:workspaceId/subscription-history')
  @UseGuards(JwtAuthGuard)
  async getSubscriptionHistory(
    @Param('workspaceId') workspaceId: string,
    @Query('limit') limit?: string,
  ) {
    return await this.dashboardService.getSubscriptionHistory(
      workspaceId,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  // Invoice endpoints
  @Get('workspaces/:workspaceId/invoices')
  @UseGuards(JwtAuthGuard)
  async getWorkspaceInvoices(
    @Param('workspaceId') workspaceId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return await this.invoiceService.getWorkspaceInvoices(
      workspaceId,
      limit ? parseInt(limit, 10) : 10,
      offset ? parseInt(offset, 10) : 0,
    );
  }

  @Get('users/invoices')
  @UseGuards(JwtAuthGuard)
  async getUserInvoices(
    @CurrentUser() user: { userId: string; email: string },
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return await this.invoiceService.getUserInvoices(
      user.userId,
      limit ? parseInt(limit, 10) : 10,
      offset ? parseInt(offset, 10) : 0,
    );
  }

  @Get('invoices/:invoiceId')
  @UseGuards(JwtAuthGuard)
  async getInvoiceDetails(@Param('invoiceId') invoiceId: string) {
    return await this.invoiceService.getInvoiceDetails(parseInt(invoiceId, 10));
  }

  @Get('invoices/:invoiceId/pdf')
  @UseGuards(JwtAuthGuard)
  async getInvoicePdf(@Param('invoiceId') invoiceId: string) {
    const pdfUrl = await this.invoiceService.getInvoicePdfUrl(parseInt(invoiceId, 10));
    return { pdfUrl };
  }

  @Get('workspaces/:workspaceId/upcoming-invoice')
  @UseGuards(JwtAuthGuard)
  async getUpcomingInvoice(@Param('workspaceId') workspaceId: string) {
    return await this.invoiceService.getUpcomingInvoice(workspaceId);
  }

  // Payment method endpoints
  @Get('users/payment-methods')
  @UseGuards(JwtAuthGuard)
  async getPaymentMethods(
    @CurrentUser() user: { userId: string; email: string },
  ) {
    return await this.paymentMethodService.getUserPaymentMethods(user.userId);
  }

  @Post('users/payment-methods')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async addPaymentMethod(
    @CurrentUser() user: { userId: string; email: string },
    @Body() body: { paymentMethodId: string; setAsDefault?: boolean },
  ) {
    return await this.paymentMethodService.addPaymentMethod(
      user.userId,
      body.paymentMethodId,
      body.setAsDefault,
    );
  }

  @Post('users/payment-methods/:paymentMethodId/set-default')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async setDefaultPaymentMethod(
    @CurrentUser() user: { userId: string; email: string },
    @Param('paymentMethodId') paymentMethodId: string,
  ) {
    return await this.paymentMethodService.setDefaultPaymentMethod(
      user.userId,
      parseInt(paymentMethodId, 10),
    );
  }

  @Delete('users/payment-methods/:paymentMethodId')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async removePaymentMethod(
    @CurrentUser() user: { userId: string; email: string },
    @Param('paymentMethodId') paymentMethodId: string,
  ) {
    return await this.paymentMethodService.removePaymentMethod(
      user.userId,
      parseInt(paymentMethodId, 10),
    );
  }

  @Post('users/payment-methods/setup-intent')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async createSetupIntent(
    @CurrentUser() user: { userId: string; email: string },
  ) {
    return await this.paymentMethodService.createSetupIntent(user.userId);
  }

  @Post('users/payment-methods/sync')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async syncPaymentMethods(
    @CurrentUser() user: { userId: string; email: string },
  ) {
    await this.paymentMethodService.syncPaymentMethodsFromStripe(user.userId);
    return { message: 'Payment methods synced successfully' };
  }

  @Post('webhooks/stripe')
  @HttpCode(HttpStatus.OK)
  async handleStripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    const rawBody = req.rawBody;

    if (!rawBody) {
      throw new Error('Raw body is required for webhook verification');
    }

    // Construct event from webhook
    const event = this.stripeService.constructWebhookEvent(rawBody, signature);

    // Process webhook
    await this.webhookService.handleWebhook(event);

    return { received: true };
  }
}
