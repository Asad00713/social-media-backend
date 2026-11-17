import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { plans } from '../../drizzle/schema/billing.schema';
import { users } from '../../drizzle/schema/users.schema';
import { workspace } from '../../drizzle/schema/workspace.schema';
import { EmailOnceService } from '../../email/email-once.service';
import { AppLinks } from '../../email/links/app-links';
import { formatDay } from '../../email/links/format-when';
import { EmailOutboxService } from '../../email/queue/email-outbox.service';
import { PAYMENT_FAILED } from '../../email/templates/billing/payment-failed';
import {
  PLAN_CHANGED,
  type PlanChangeKind,
} from '../../email/templates/billing/plan-changed';
import { TRIAL_ENDING } from '../../email/templates/billing/trial-ending';
import { NotificationEmitterService } from '../../notifications/notification-emitter.service';
import { NotifyService } from '../../notifications/notify.service';
import { RecipientsService } from '../../notifications/recipients.service';
import { liveWorkspaces } from '../../posts/soft-delete/soft-delete';

export interface PaymentFailedInput {
  userId: string;
  planName: string;
  amountCents: number;
  currency: string;
  cardLast4: string | null;
  cardBrand: string | null;
  reason: string | null;
  nextAttempt: Date | null;
  dedupeKey: string;
}

export interface TrialEndingInput {
  userId: string;
  subscriptionId: number | string;
  trialEnd: Date;
  planCode: string;
  /** false = the provider says no card is on file; null = unknown. */
  hasCard: boolean | null;
}

export interface PlanChangedInput {
  userId: string;
  kind: PlanChangeKind;
  fromPlan: string;
  toPlan: string;
  billed: string | null;
  nextCharge: Date | null;
  endsOn: Date | null;
  dedupeKey: string;
  /** Only Stripe sends a receipt of its own (an upgrade says so). */
  provider?: 'stripe' | 'lemonsqueezy';
}

interface PlanRow {
  code: string;
  name: string;
  channelsPerWorkspace: number;
  membersPerWorkspace: number;
  aiTokensPerMonth: number;
}

interface BillingContext {
  workspaceId: string | null;
  workspaceName: string;
  timezone: string;
  billingUrl: string;
}

/** How many days ahead the provider (or the cron) warns of a trial end. */
const TRIAL_WARNING_DAYS = 3;
const TRIAL_CLAIM_TTL_SECONDS = 7 * 24 * 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REASON_CHARS = 200;
const FALLBACK_WORKSPACE_NAME = 'your workspace';
const FALLBACK_TIMEZONE = 'UTC';

/** `$29.00`; an unknown currency code falls back to `29.00 CODE`. */
export function formatMoney(cents: number, currency: string): string {
  const code = currency.toUpperCase();
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${code}`;
  }
}

/** `$29 monthly` / `$29.50 monthly`: the price a plan row bills. */
export function formatMonthlyPrice(cents: number): string {
  const price = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
  return `${price} monthly`;
}

/**
 * An email idempotency key from its parts. Anything outside
 * `[A-Za-z0-9._-]` (a `:` is forbidden in a BullMQ job id) becomes `_`.
 */
export function billingEmailKey(...parts: Array<string | number>): string {
  return parts
    .map((part) => String(part).replace(/[^A-Za-z0-9._-]/g, '_'))
    .join('.')
    .slice(0, 200);
}

/** `visa` -> `Visa`, `american_express` -> `American Express`. */
function cardLabel(brand: string | null, last4: string | null): string | null {
  if (!last4 || !/^\d{4}$/.test(last4)) return null;
  const words =
    brand && /^[A-Za-z_ ]{1,30}$/.test(brand)
      ? brand
          .split(/[_ ]+/)
          .filter(Boolean)
          .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
          .join(' ')
      : '';
  return `${words || 'Card'} •• ${last4}`;
}

/** One sentence: single line, at most 200 characters, ending in a full stop. */
function reasonSentence(reason: string | null): string | null {
  const clean = (reason ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const clipped =
    clean.length > MAX_REASON_CHARS
      ? `${clean.slice(0, MAX_REASON_CHARS - 1)}…`
      : clean;
  return /[.!?…]$/.test(clipped) ? clipped : `${clipped}.`;
}

/** -1 means unlimited. */
function limitLabel(value: number): string {
  return value < 0 ? 'Unlimited' : value.toLocaleString('en-US');
}

function limitOrNull(value: number | undefined): number | null {
  return value === undefined || value < 0 ? null : value;
}

/**
 * The D emails: payment failed, trial ending, plan changed. Every method
 * swallows its own failure (logged without an address), so a webhook or a
 * plan change can call it without a try/catch and a mail problem can never
 * make the provider retry and double-apply.
 *
 * The email is mandatory (`event: null` on the templates); the bell follows
 * the person's `billing_alert` app preference. Payment failed has no bell
 * here: PaymentAlertsService rings it.
 */
@Injectable()
export class BillingEmailService {
  private readonly logger = new Logger(BillingEmailService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly notify: NotifyService,
    private readonly recipients: RecipientsService,
    private readonly once: EmailOnceService,
    private readonly links: AppLinks,
    private readonly emitter: NotificationEmitterService,
    private readonly outbox: EmailOutboxService,
  ) {}

  /**
   * The email only. The bell and the live "Payment failed" toast are
   * PaymentAlertsService's, which both webhooks call for the same event, so a
   * bell here would ring twice.
   */
  async paymentFailed(i: PaymentFailedInput): Promise<void> {
    await this.guarded('payment failed', i.userId, async () => {
      const ctx = await this.context(i.userId);
      const free = (await this.plans()).find((p) => p.code === 'FREE');
      await this.notify.notify({
        userId: i.userId,
        workspaceId: ctx.workspaceId,
        event: 'billing_alert',
        email: {
          template: PAYMENT_FAILED,
          props: {
            planName: i.planName,
            amount: formatMoney(i.amountCents, i.currency),
            card: cardLabel(i.cardBrand, i.cardLast4),
            reason: reasonSentence(i.reason),
            nextTry: i.nextAttempt
              ? formatDay(i.nextAttempt, ctx.timezone)
              : null,
            freeChannels: free ? limitOrNull(free.channelsPerWorkspace) : null,
            billingUrl: ctx.billingUrl,
          },
          idempotencyKey: i.dedupeKey,
        },
      });
    });
  }

  /**
   * Once per trial: Stripe's warning and the LS cron both come here, and the
   * claim (a week, keyed by subscription and trial end) keeps a re-run, a
   * second instance or a changed trial date from sending twice.
   */
  async trialEnding(i: TrialEndingInput): Promise<void> {
    await this.guarded('trial ending', i.userId, async () => {
      const all = await this.plans();
      const current = all.find((p) => p.code === i.planCode);
      const free = all.find((p) => p.code === 'FREE');
      if (!current || !free) {
        this.logger.warn(
          `Trial-ending email skipped: plan ${i.planCode} or FREE not found`,
        );
        return;
      }
      const key = billingEmailKey(
        'trial-ending',
        i.subscriptionId,
        i.trialEnd.getTime(),
      );
      // Everything that can fail on a read comes BEFORE the claim, so a
      // failure there leaves the trial unclaimed for the next run.
      const ctx = await this.context(i.userId);
      const address = (await this.recipients.user(i.userId))?.email;
      if (!address) {
        this.logger.warn(
          `Trial-ending email skipped: user ${i.userId} has no address`,
        );
        return;
      }
      const daysLeft = Math.max(
        1,
        Math.ceil((i.trialEnd.getTime() - Date.now()) / DAY_MS),
      );
      if (!(await this.once.claim(key, TRIAL_CLAIM_TTL_SECONDS))) return;

      // Enqueued directly, not through NotifyService, which swallows an
      // enqueue failure: here a failure must give the claim back, or the
      // trial would never be mailed. A timeout ("not queued") counts too.
      let queued: boolean;
      try {
        queued = await this.outbox.enqueue({
          template: TRIAL_ENDING,
          to: { email: address, userId: i.userId },
          workspaceId: ctx.workspaceId,
          idempotencyKey: key,
          props: {
            planName: current.name,
            trialEnd: formatDay(i.trialEnd, ctx.timezone),
            daysLeft,
            workspaceName: ctx.workspaceName,
            hasCard: i.hasCard,
            channels: limitOrNull(current.channelsPerWorkspace),
            changes: [
              {
                label: 'Channels',
                value: `${limitLabel(current.channelsPerWorkspace)} → ${limitLabel(free.channelsPerWorkspace)} publishing`,
              },
              {
                label: 'Members',
                value: `${limitLabel(current.membersPerWorkspace)} → ${limitLabel(free.membersPerWorkspace)}`,
              },
              {
                label: 'AI credits',
                value: `${limitLabel(current.aiTokensPerMonth)} → ${limitLabel(free.aiTokensPerMonth)} a month`,
              },
              { label: 'Your posts', value: 'All kept' },
            ],
            billingUrl: ctx.billingUrl,
          },
        });
      } catch (err) {
        await this.once.release(key);
        throw err;
      }
      if (!queued) {
        await this.once.release(key);
        this.logger.warn(
          `Trial-ending email for user ${i.userId} not queued; the next run tries again`,
        );
        return;
      }

      await this.notify.notify({
        userId: i.userId,
        workspaceId: ctx.workspaceId,
        event: 'billing_alert',
        bell: () =>
          this.emitter.subscriptionExpiring(
            i.userId,
            TRIAL_WARNING_DAYS,
            current.name,
          ),
      });
    });
  }

  async planChanged(i: PlanChangedInput): Promise<void> {
    await this.guarded('plan changed', i.userId, async () => {
      const ctx = await this.context(i.userId);
      const target = (await this.plans()).find(
        (p) => p.name === i.toPlan || p.code === i.toPlan,
      );
      const isSwitch =
        i.kind === 'upgraded' ||
        i.kind === 'downgraded' ||
        i.kind === 'downgrade_scheduled';
      await this.notify.notify({
        userId: i.userId,
        workspaceId: ctx.workspaceId,
        event: 'billing_alert',
        // The in-app "Plan Updated" bell exists for plan switches only.
        ...(isSwitch
          ? {
              bell: () =>
                this.emitter.planChanged(i.userId, i.fromPlan, i.toPlan),
            }
          : {}),
        email: {
          template: PLAN_CHANGED,
          props: {
            kind: i.kind,
            fromPlan: i.fromPlan,
            toPlan: i.toPlan,
            billed: i.billed,
            nextCharge: i.nextCharge
              ? formatDay(i.nextCharge, ctx.timezone)
              : null,
            endsOn: i.endsOn ? formatDay(i.endsOn, ctx.timezone) : null,
            channels: limitOrNull(target?.channelsPerWorkspace),
            members: limitOrNull(target?.membersPerWorkspace),
            showStripeReceipt: i.kind === 'upgraded' && i.provider === 'stripe',
            billingUrl: ctx.billingUrl,
          },
          idempotencyKey: i.dedupeKey,
        },
      });
    });
  }

  /** A plan code's display name; the code itself when the plan is unknown. */
  async planName(code: string): Promise<string> {
    try {
      return (await this.plans()).find((p) => p.code === code)?.name ?? code;
    } catch {
      return code;
    }
  }

  private async guarded(
    what: string,
    userId: string,
    work: () => Promise<void>,
  ): Promise<void> {
    try {
      await work();
    } catch (err) {
      this.logger.warn(
        `Billing email (${what}) failed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async plans(): Promise<PlanRow[]> {
    return this.db
      .select({
        code: plans.code,
        name: plans.name,
        channelsPerWorkspace: plans.channelsPerWorkspace,
        membersPerWorkspace: plans.membersPerWorkspace,
        aiTokensPerMonth: plans.aiTokensPerMonth,
      })
      .from(plans);
  }

  /**
   * The workspace the copy and the billing link refer to: the one the person
   * last opened, else the first they own. A subscription belongs to the
   * account, so with neither the mail still goes out, linking to the app root.
   */
  private async context(userId: string): Promise<BillingContext> {
    const [row] = await this.db
      .select({ last: users.lastAccessedWorkspaceId })
      .from(users)
      .where(eq(users.id, userId));
    let info = row?.last ? await this.recipients.workspace(row.last) : null;
    if (!info) {
      const [owned] = await this.db
        .select({ id: workspace.id })
        .from(workspace)
        .where(and(eq(workspace.ownerId, userId), liveWorkspaces()))
        .orderBy(asc(workspace.createdAt), asc(workspace.id))
        .limit(1);
      info = owned ? await this.recipients.workspace(owned.id) : null;
    }
    return {
      workspaceId: info?.id ?? null,
      workspaceName: info?.name ?? FALLBACK_WORKSPACE_NAME,
      timezone: info?.timezone || FALLBACK_TIMEZONE,
      billingUrl: info ? this.links.billing(info.id) : this.links.frontend('/'),
    };
  }
}
