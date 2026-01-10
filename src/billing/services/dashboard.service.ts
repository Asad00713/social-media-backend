import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import {
  subscriptions,
  subscriptionItems,
  plans,
  workspaceUsage,
  invoices,
  subscriptionChanges,
  workspace,
  stripeCustomers,
  Plan,
} from '../../drizzle/schema';

export interface BillingDashboard {
  subscription: {
    id: number;
    planCode: string;
    planName: string;
    status: string;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
    trialEnd: Date | null;
  } | null;
  usage: {
    channelsCount: number;
    channelsLimit: number;
    channelsPercentage: number;
    membersCount: number;
    membersLimit: number;
    membersPercentage: number;
    extraChannelsPurchased: number;
    extraMembersPurchased: number;
  } | null;
  billing: {
    monthlyTotal: number;
    monthlyTotalFormatted: string;
    basePlanCost: number;
    addonsCost: number;
    nextBillingDate: Date | null;
  };
  recentInvoices: {
    id: number;
    stripeInvoiceId: string;
    totalCents: number;
    totalFormatted: string;
    status: string;
    paidAt: Date | null;
    periodStart: Date | null;
    periodEnd: Date | null;
  }[];
  recentChanges: {
    id: number;
    changeType: string;
    effectiveDate: Date;
    reason: string | null;
  }[];
}

export interface UserBillingSummary {
  totalWorkspaces: number;
  totalMonthlySpend: number;
  totalMonthlySpendFormatted: string;
  workspaces: {
    id: string;
    name: string;
    planCode: string;
    planName: string;
    monthlyCost: number;
    monthlyCostFormatted: string;
    status: string;
  }[];
  hasStripeCustomer: boolean;
  defaultPaymentMethod: {
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
  } | null;
}

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  // Get billing dashboard for a workspace
  async getWorkspaceDashboard(workspaceId: string): Promise<BillingDashboard> {
    // Get workspace
    const ws = await db
      .select()
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1);

    if (ws.length === 0) {
      throw new NotFoundException('Workspace not found');
    }

    // Get subscription with plan details
    const subscription = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.workspaceId, workspaceId))
      .limit(1);

    let subscriptionData: BillingDashboard['subscription'] = null;
    let planData: Plan | null = null;

    if (subscription.length > 0) {
      const sub = subscription[0];
      const plan = await db
        .select()
        .from(plans)
        .where(eq(plans.code, sub.planCode))
        .limit(1);

      planData = plan[0] || null;

      subscriptionData = {
        id: sub.id,
        planCode: sub.planCode,
        planName: planData?.name || sub.planCode,
        status: sub.status,
        currentPeriodStart: sub.currentPeriodStart,
        currentPeriodEnd: sub.currentPeriodEnd,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        trialEnd: sub.trialEnd,
      };
    }

    // Get usage
    const usage = await db
      .select()
      .from(workspaceUsage)
      .where(eq(workspaceUsage.workspaceId, workspaceId))
      .limit(1);

    let usageData: BillingDashboard['usage'] = null;
    if (usage.length > 0) {
      const u = usage[0];
      const totalChannels = u.channelsLimit + u.extraChannelsPurchased;
      const totalMembers = u.membersLimit + u.extraMembersPurchased;

      usageData = {
        channelsCount: u.channelsCount,
        channelsLimit: totalChannels,
        channelsPercentage: totalChannels > 0 ? Math.round((u.channelsCount / totalChannels) * 100) : 0,
        membersCount: u.membersCount,
        membersLimit: totalMembers,
        membersPercentage: totalMembers > 0 ? Math.round((u.membersCount / totalMembers) * 100) : 0,
        extraChannelsPurchased: u.extraChannelsPurchased,
        extraMembersPurchased: u.extraMembersPurchased,
      };
    }

    // Calculate billing
    let basePlanCost = 0;
    let addonsCost = 0;

    if (subscription.length > 0) {
      const items = await db
        .select()
        .from(subscriptionItems)
        .where(eq(subscriptionItems.subscriptionId, subscription[0].id));

      for (const item of items) {
        if (item.itemType === 'BASE_PLAN') {
          basePlanCost = item.unitPriceCents;
        } else {
          addonsCost += item.unitPriceCents * item.quantity;
        }
      }
    }

    if (planData && basePlanCost === 0) {
      basePlanCost = planData.basePriceCents;
    }

    const monthlyTotal = basePlanCost + addonsCost;

    // Get recent invoices
    let recentInvoices: BillingDashboard['recentInvoices'] = [];
    if (subscription.length > 0) {
      const invs = await db
        .select()
        .from(invoices)
        .where(eq(invoices.subscriptionId, subscription[0].id))
        .orderBy(desc(invoices.createdAt))
        .limit(5);

      recentInvoices = invs.map((inv) => ({
        id: inv.id,
        stripeInvoiceId: inv.stripeInvoiceId,
        totalCents: inv.totalCents,
        totalFormatted: `$${(inv.totalCents / 100).toFixed(2)}`,
        status: inv.status,
        paidAt: inv.paidAt,
        periodStart: inv.periodStart,
        periodEnd: inv.periodEnd,
      }));
    }

    // Get recent changes
    let recentChanges: BillingDashboard['recentChanges'] = [];
    if (subscription.length > 0) {
      const changes = await db
        .select()
        .from(subscriptionChanges)
        .where(eq(subscriptionChanges.subscriptionId, subscription[0].id))
        .orderBy(desc(subscriptionChanges.createdAt))
        .limit(5);

      recentChanges = changes.map((change) => ({
        id: change.id,
        changeType: change.changeType,
        effectiveDate: change.effectiveDate,
        reason: change.reason,
      }));
    }

    return {
      subscription: subscriptionData,
      usage: usageData,
      billing: {
        monthlyTotal,
        monthlyTotalFormatted: `$${(monthlyTotal / 100).toFixed(2)}/month`,
        basePlanCost,
        addonsCost,
        nextBillingDate: subscriptionData?.currentPeriodEnd || null,
      },
      recentInvoices,
      recentChanges,
    };
  }

  // Get billing summary for a user (all workspaces)
  async getUserBillingSummary(userId: string): Promise<UserBillingSummary> {
    // Get user's workspaces
    const workspaces = await db
      .select()
      .from(workspace)
      .where(eq(workspace.ownerId, userId));

    // Get Stripe customer
    const customer = await db
      .select()
      .from(stripeCustomers)
      .where(eq(stripeCustomers.userId, userId))
      .limit(1);

    const workspaceSummaries: UserBillingSummary['workspaces'] = [];
    let totalMonthlySpend = 0;

    for (const ws of workspaces) {
      const subscription = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.workspaceId, ws.id))
        .limit(1);

      if (subscription.length > 0) {
        const sub = subscription[0];
        const plan = await db
          .select()
          .from(plans)
          .where(eq(plans.code, sub.planCode))
          .limit(1);

        // Calculate workspace cost
        let monthlyCost = plan[0]?.basePriceCents || 0;

        const items = await db
          .select()
          .from(subscriptionItems)
          .where(eq(subscriptionItems.subscriptionId, sub.id));

        for (const item of items) {
          if (item.itemType !== 'BASE_PLAN') {
            monthlyCost += item.unitPriceCents * item.quantity;
          }
        }

        if (sub.status === 'active') {
          totalMonthlySpend += monthlyCost;
        }

        workspaceSummaries.push({
          id: ws.id,
          name: ws.name,
          planCode: sub.planCode,
          planName: plan[0]?.name || sub.planCode,
          monthlyCost,
          monthlyCostFormatted: `$${(monthlyCost / 100).toFixed(2)}/month`,
          status: sub.status,
        });
      } else {
        workspaceSummaries.push({
          id: ws.id,
          name: ws.name,
          planCode: 'NONE',
          planName: 'No Plan',
          monthlyCost: 0,
          monthlyCostFormatted: '$0.00/month',
          status: 'none',
        });
      }
    }

    return {
      totalWorkspaces: workspaces.length,
      totalMonthlySpend,
      totalMonthlySpendFormatted: `$${(totalMonthlySpend / 100).toFixed(2)}/month`,
      workspaces: workspaceSummaries,
      hasStripeCustomer: customer.length > 0,
      defaultPaymentMethod: null, // Will be populated by payment method service
    };
  }

  // Get subscription history for a workspace
  async getSubscriptionHistory(
    workspaceId: string,
    limit: number = 20,
  ): Promise<any[]> {
    const subscription = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.workspaceId, workspaceId))
      .limit(1);

    if (subscription.length === 0) {
      return [];
    }

    const changes = await db
      .select()
      .from(subscriptionChanges)
      .where(eq(subscriptionChanges.subscriptionId, subscription[0].id))
      .orderBy(desc(subscriptionChanges.createdAt))
      .limit(limit);

    return changes.map((change) => ({
      id: change.id,
      changeType: change.changeType,
      oldValue: change.oldValue,
      newValue: change.newValue,
      prorationAmountCents: change.prorationAmountCents,
      prorationAmountFormatted: change.prorationAmountCents
        ? `$${(change.prorationAmountCents / 100).toFixed(2)}`
        : null,
      effectiveDate: change.effectiveDate,
      reason: change.reason,
      createdAt: change.createdAt,
    }));
  }
}
