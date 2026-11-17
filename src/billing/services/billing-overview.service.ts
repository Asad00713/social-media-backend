import {
  BadGatewayException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, gte, notLike, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { DbType } from '../../drizzle/db';
import {
  aiUsageLog,
  billingPaymentAlerts,
  workspace,
  type Subscription,
} from '../../drizzle/schema';
import { BestTimesCache } from '../../planner/lib/best-times-cache';
import type {
  BillingProfile,
  PaymentProviderAdapter,
  PortalIntent,
  ProviderInvoice,
} from '../providers/payment-provider.interface';
import { ProviderRegistryService } from '../providers/provider-registry.service';
import { DashboardService } from './dashboard.service';
import { SubscriptionLookupService } from './subscription-lookup.service';
import { getNextTokenResetDate } from './token-reset.util';
import { PAYMENT_GRACE_DAYS } from './webhook.service';

/**
 * The shape the settings billing page renders from (spec section 5.8).
 *
 * `profileUnavailable` is the one field beyond the spec: it is true when the
 * provider could not be reached for the card and billing details, so the page
 * can say "couldn't load" instead of presenting a missing card as "No card yet".
 */
export interface BillingOverview {
  provider: 'lemonsqueezy' | 'stripe';
  plan: {
    code: string;
    name: string;
    priceCents: number;
    interval: 'month' | 'year';
  };
  status:
    | 'free'
    | 'trialing'
    | 'active'
    | 'past_due'
    | 'cancelled_at_period_end';
  renewsAt: string | null;
  endsAt: string | null;
  card: { brand: string | null; last4: string | null } | null;
  billingDetails: {
    name: string | null;
    email: string | null;
    country: string | null;
  } | null;
  profileUnavailable: boolean;
  paymentFailure: {
    amountCents: number;
    currency: string;
    graceUntil: string;
  } | null;
  nextInvoice: {
    amountCents: number;
    currency: string;
    date: string;
  } | null;
  usage: {
    channels: { used: number; limit: number };
    members: { used: number; limit: number };
    aiCredits: {
      used: number;
      limit: number;
      resetsAt: string;
      byFeature: Array<{ feature: string; used: number }> | null;
    };
  };
}

/**
 * `invoices` is always an array; `invoicesUnavailable` says whether an empty
 * one means "none yet" (false) or "the provider could not be reached" (true).
 */
export interface ProviderInvoicesResult {
  invoices: ProviderInvoice[];
  invoicesUnavailable: boolean;
}

/** Rows the invoice table shows. */
export const DEFAULT_INVOICE_LIMIT = 24;
/** Lemon Squeezy answers 422 to a `page[size]` above this. */
export const MAX_INVOICE_LIMIT = 100;
/** A provider call that takes longer than this is treated as unavailable. */
export const PROVIDER_TIMEOUT_MS = 10_000;
/** Card, billing details and invoices are re-read at most this often. */
export const PROVIDER_CACHE_TTL_MS = 10 * 60 * 1000;

const CACHE_MAX_ENTRIES = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Failure rows read when looking for the start of the current dunning run. */
const ALERT_WINDOW = 50;

/** A provider call exceeded `PROVIDER_TIMEOUT_MS`. */
export class ProviderTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not answer within ${ms}ms`);
    this.name = 'ProviderTimeoutError';
  }
}

/**
 * Runs `call` and gives up after `ms`, through an AbortController.
 *
 * The adapters take no abort signal, so the underlying request is not
 * cancelled: it finishes in the background and its result is dropped. What the
 * timeout buys is that a hung provider cannot hold a settings page open.
 */
export async function withProviderTimeout<T>(
  what: string,
  call: () => Promise<T>,
  ms: number = PROVIDER_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await new Promise<T>((resolve, reject) => {
      controller.signal.addEventListener('abort', () =>
        reject(new ProviderTimeoutError(what, ms)),
      );
      call().then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One call behind the settings billing page: the overview, the provider's
 * invoices and the portal link.
 *
 * Provider reads (card, billing details, invoices) are the parts that can be
 * down while our own data is fine, so they DEGRADE: the page still loads, with
 * that part empty and a flag saying why. The portal link is the exception, it
 * IS a provider call, so its failure is the answer.
 */
@Injectable()
export class BillingOverviewService {
  private readonly logger = new Logger(BillingOverviewService.name);

  // Version = the subscription's `updated_at`, so a webhook that changes the
  // subscription (new card, new plan) invalidates before the TTL runs out.
  private readonly invoiceCache = new BestTimesCache<ProviderInvoice[]>(
    PROVIDER_CACHE_TTL_MS,
    CACHE_MAX_ENTRIES,
    () => Date.now(),
  );
  private readonly profileCache = new BestTimesCache<BillingProfile>(
    PROVIDER_CACHE_TTL_MS,
    CACHE_MAX_ENTRIES,
    () => Date.now(),
  );

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly lookup: SubscriptionLookupService,
    private readonly dashboard: DashboardService,
    private readonly registry: ProviderRegistryService,
  ) {}

  async overview(workspaceId: string): Promise<BillingOverview> {
    const sub = await this.lookup.findByWorkspaceId(workspaceId);
    const ownerId = await this.lookup.getOwnerId(workspaceId);
    if (!ownerId) throw new NotFoundException('Workspace not found');

    const dash = await this.dashboard.getWorkspaceDashboard(workspaceId);
    // A FREE row is the same as no row: nothing is billed, so nothing is asked
    // of the provider.
    const paidSub = sub && sub.planCode !== 'FREE' ? sub : null;
    const status = paidSub ? this.statusOf(paidSub) : 'free';
    const cancelling = status === 'cancelled_at_period_end';

    const adapter = paidSub
      ? await this.registry.adapterForSubscription(paidSub.id)
      : null;
    const provider = adapter
      ? adapter.name
      : await this.registry.providerForUser(ownerId);

    const periodEnd = paidSub?.currentPeriodEnd?.toISOString() ?? null;
    const monthlyTotal = dash.billing.monthlyTotal;

    const [profile, paymentFailure, byFeature] = await Promise.all([
      paidSub && adapter
        ? this.profileOf(adapter, paidSub)
        : Promise.resolve({ profile: null, unavailable: false }),
      status === 'past_due' && paidSub && adapter
        ? this.paymentFailureOf(adapter, paidSub, ownerId, monthlyTotal)
        : Promise.resolve(null),
      this.aiUsageByFeature(ownerId),
    ]);

    const usage = dash.usage;
    return {
      provider,
      plan: {
        code: paidSub?.planCode ?? 'FREE',
        name: dash.subscription?.planName ?? 'Free',
        priceCents: paidSub ? dash.billing.basePlanCost : 0,
        interval: 'month',
      },
      status,
      renewsAt: paidSub && !cancelling ? periodEnd : null,
      endsAt: cancelling ? periodEnd : null,
      card: profile.profile?.card ?? null,
      billingDetails: profile.profile?.billingDetails ?? null,
      profileUnavailable: profile.unavailable,
      paymentFailure,
      nextInvoice:
        paidSub && !cancelling && periodEnd
          ? { amountCents: monthlyTotal, currency: 'USD', date: periodEnd }
          : null,
      usage: {
        channels: {
          used: usage?.channelsCount ?? 0,
          limit: usage?.channelsLimit ?? 0,
        },
        members: {
          used: usage?.membersCount ?? 0,
          limit: usage?.membersLimit ?? 0,
        },
        aiCredits: {
          used: usage?.aiTokensUsed ?? 0,
          limit: usage?.aiTokensLimit ?? 0,
          resetsAt: getNextTokenResetDate().toISOString(),
          byFeature,
        },
      },
    };
  }

  /**
   * Newest first, 10-minute cache per subscription. A provider failure is not
   * an error here: the page gets an empty list and `invoicesUnavailable`.
   * Failures are never cached.
   */
  async invoices(
    workspaceId: string,
    limit: number = DEFAULT_INVOICE_LIMIT,
  ): Promise<ProviderInvoicesResult> {
    const sub = await this.lookup.findByWorkspaceId(workspaceId);
    if (!sub || sub.planCode === 'FREE') {
      return { invoices: [], invoicesUnavailable: false };
    }

    const adapter = await this.registry.adapterForSubscription(sub.id);
    try {
      return {
        invoices: await this.invoicesOf(adapter, sub, clampLimit(limit)),
        invoicesUnavailable: false,
      };
    } catch (err) {
      this.logger.warn(
        `Provider invoices for subscription ${sub.id} unavailable: ${describe(err)}`,
      );
      return { invoices: [], invoicesUnavailable: true };
    }
  }

  /**
   * A fresh signed URL every call (never cached: the provider's links are
   * short-lived). `workspaceId` is the route's guard-validated workspace, so
   * the portal returns the person to the page they came from.
   */
  async portalLink(
    workspaceId: string,
    intent: PortalIntent,
  ): Promise<{ url: string }> {
    const sub = await this.lookup.findByWorkspaceId(workspaceId);
    if (!sub || sub.planCode === 'FREE') {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        code: 'NO_SUBSCRIPTION',
        message: 'This account has no paid plan to manage.',
      });
    }

    const adapter = await this.registry.adapterForSubscription(sub.id);
    try {
      return await withProviderTimeout('Billing portal link', () =>
        adapter.createPortalLink(sub.id, intent, { workspaceId }),
      );
    } catch (err) {
      if (!(err instanceof ProviderTimeoutError)) throw err;
      this.logger.error(
        `Portal link for subscription ${sub.id}: ${err.message}`,
      );
      throw new BadGatewayException({
        statusCode: 502,
        error: 'Bad Gateway',
        code: 'PORTAL_UNAVAILABLE',
        message: 'The billing portal is not available right now.',
      });
    }
  }

  // ------------------------------------------------------------------ helpers

  private statusOf(sub: Subscription): BillingOverview['status'] {
    if (sub.status === 'trialing') return 'trialing';
    if (sub.status === 'past_due') return 'past_due';
    if (sub.cancelAtPeriodEnd) return 'cancelled_at_period_end';
    return 'active';
  }

  private async invoicesOf(
    adapter: PaymentProviderAdapter,
    sub: Subscription,
    limit: number,
  ): Promise<ProviderInvoice[]> {
    const key = `${sub.id}:${limit}`;
    const version = sub.updatedAt.toISOString();
    const hit = this.invoiceCache.get(key, version);
    if (hit) return hit;

    const rows = await withProviderTimeout('Provider invoices', () =>
      adapter.listInvoices(sub.id, limit),
    );
    this.invoiceCache.set(key, version, rows);
    return rows;
  }

  /** Card and billing details, cached; a provider error yields no profile. */
  private async profileOf(
    adapter: PaymentProviderAdapter,
    sub: Subscription,
  ): Promise<{ profile: BillingProfile | null; unavailable: boolean }> {
    const key = String(sub.id);
    const version = sub.updatedAt.toISOString();
    const hit = this.profileCache.get(key, version);
    if (hit) return { profile: hit, unavailable: false };

    try {
      const profile = await withProviderTimeout(
        'Provider billing profile',
        () => adapter.getBillingProfile(sub.id),
      );
      this.profileCache.set(key, version, profile);
      return { profile, unavailable: false };
    } catch (err) {
      this.logger.warn(
        `Billing profile for subscription ${sub.id} unavailable: ${describe(err)}`,
      );
      return { profile: null, unavailable: true };
    }
  }

  /**
   * Amount: the newest `failed` provider invoice, else what the next invoice
   * would be. Deadline: the first failure of the CURRENT dunning run (the
   * oldest `failed` alert after the latest `recovered` one) plus
   * `PAYMENT_GRACE_DAYS`. With no alert on record (the alert write is
   * best-effort) the subscription's own `updated_at`, which moved when it
   * went past due, stands in so the banner still has a date.
   */
  private async paymentFailureOf(
    adapter: PaymentProviderAdapter,
    sub: Subscription,
    ownerId: string,
    monthlyTotal: number,
  ): Promise<BillingOverview['paymentFailure']> {
    let failed: ProviderInvoice | undefined;
    try {
      const rows = await this.invoicesOf(adapter, sub, DEFAULT_INVOICE_LIMIT);
      failed = rows.find((r) => r.status === 'failed');
    } catch (err) {
      this.logger.warn(
        `Failed-invoice lookup for subscription ${sub.id} unavailable: ${describe(err)}`,
      );
    }

    const alerts = await this.db
      .select({
        kind: billingPaymentAlerts.kind,
        createdAt: billingPaymentAlerts.createdAt,
      })
      .from(billingPaymentAlerts)
      .where(eq(billingPaymentAlerts.userId, ownerId))
      .orderBy(
        desc(billingPaymentAlerts.createdAt),
        desc(billingPaymentAlerts.id),
      )
      .limit(ALERT_WINDOW);

    // Newest first: walk back to the latest recovery; the oldest failure seen
    // before it is where this run of failures began.
    let runStart: Date | null = null;
    for (const alert of alerts) {
      if (alert.kind === 'recovered') break;
      runStart = alert.createdAt;
    }

    const graceStart = runStart ?? sub.updatedAt;
    return {
      amountCents: failed?.amountCents ?? monthlyTotal,
      currency: failed?.currency ?? 'USD',
      graceUntil: new Date(
        graceStart.getTime() + PAYMENT_GRACE_DAYS * DAY_MS,
      ).toISOString(),
    };
  }

  /**
   * AI credits spent this month by operation, across every workspace the
   * account owns (credits are per workspace, the plan is per account).
   * BYOK rows (`*_byok`) were not charged to the plan and are left out, as are
   * failed calls. `null` when nothing was logged.
   */
  private async aiUsageByFeature(
    ownerId: string,
  ): Promise<Array<{ feature: string; used: number }> | null> {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const rows = await this.db
      .select({
        feature: aiUsageLog.operation,
        used: sql<string>`coalesce(sum(${aiUsageLog.tokensUsed}), 0)`,
      })
      .from(aiUsageLog)
      .innerJoin(workspace, eq(workspace.id, aiUsageLog.workspaceId))
      .where(
        and(
          eq(workspace.ownerId, ownerId),
          gte(aiUsageLog.createdAt, monthStart),
          eq(aiUsageLog.success, true),
          notLike(aiUsageLog.operation, '%\\_byok'),
        ),
      )
      .groupBy(aiUsageLog.operation);

    const features = rows
      .map((r) => ({ feature: r.feature, used: Number(r.used) }))
      .filter((r) => r.used > 0)
      .sort((a, b) => b.used - a.used || a.feature.localeCompare(b.feature));
    return features.length > 0 ? features : null;
  }
}

/** 1..MAX_INVOICE_LIMIT; anything else (NaN, 0, huge) is pulled into range. */
export function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_INVOICE_LIMIT;
  return Math.min(MAX_INVOICE_LIMIT, Math.max(1, Math.floor(limit)));
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
