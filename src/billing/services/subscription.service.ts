import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { eq, and, sql } from 'drizzle-orm';
import Stripe from 'stripe';
import { buildSubscriptionSync } from './subscription-sync.util';
import { buildUsageFanout } from './usage-fanout.util';
import { getNextTokenResetDate } from './token-reset.util';
import { upsertInvoiceFromStripe } from './invoice-sync.util';
import { StripeService } from '../../stripe/stripe.service';
import { CustomerService } from './customer.service';
import { SubscriptionLookupService } from './subscription-lookup.service';
import { ProviderRegistryService } from '../providers/provider-registry.service';
import { createStripeSubscriptionDirect } from '../providers/stripe-direct-subscribe.util';
import {
  endStripeProviderRows,
  writeStripeBasePlanRow,
} from '../providers/stripe-provider-row.util';
import { db } from '../../drizzle/db';
import { providerSubscriptions } from '../../drizzle/schema/billing.schema';
import type { ProviderSubscription } from '../../drizzle/schema/billing.schema';
import { findItem, isLive } from './provider-subscription.util';
import {
  subscriptions,
  subscriptionItems,
  workspaceUsage,
  plans,
  workspace,
  subscriptionChanges,
  Subscription,
  NewSubscription,
  NewSubscriptionItem,
  NewWorkspaceUsage,
} from '../../drizzle/schema';
import { liveWorkspaces } from '../../posts/soft-delete/soft-delete';
import type { CancelReason } from '../dto/billing.dto';

/**
 * Local `subscriptions.status` values after which nothing bills: Stripe's
 * `canceled` and `incomplete_expired`, and `expired` (Lemon Squeezy's end,
 * and what stale-id recovery writes).
 */
const TERMINAL_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  'canceled',
  'incomplete_expired',
  'expired',
]);

/**
 * Whether cancelling this subscription (at period end or now) would do
 * anything. The one rule for "is there a plan to cancel": cancelForAccount
 * acts on it, and the workspace deletion preview warns from it, so the
 * warning and the action cannot disagree.
 *
 * Nothing to cancel: no subscription, the FREE plan (by code, never by
 * name), a terminal status (TERMINAL_SUBSCRIPTION_STATUSES), a BASE_PLAN
 * provider row that is no longer live (`isLive`: the provider says it has
 * ended, whatever the local row still says), or already set to end at the
 * period end when that is what is asked again.
 *
 * `basePlan` is the default provider's BASE_PLAN row (loadBasePlanRow);
 * undefined or null when there is none, which leaves the local row to decide.
 */
export function isCancellable(
  subscription:
    | Pick<Subscription, 'planCode' | 'status' | 'cancelAtPeriodEnd'>
    | null
    | undefined,
  atPeriodEnd: boolean,
  basePlan?: ProviderSubscription | null,
): boolean {
  if (!subscription) return false;
  if (subscription.planCode === 'FREE') return false;
  if (TERMINAL_SUBSCRIPTION_STATUSES.has(subscription.status ?? '')) {
    return false;
  }
  if (basePlan && !isLive(basePlan)) return false;
  if (atPeriodEnd && subscription.cancelAtPeriodEnd) return false;
  return true;
}

/** The default provider's BASE_PLAN row of one subscription, or null. */
export async function loadBasePlanRow(
  reader: Pick<typeof db, 'select'>,
  subscriptionId: number,
): Promise<ProviderSubscription | null> {
  const rows = (await reader
    .select()
    .from(providerSubscriptions)
    .where(
      eq(providerSubscriptions.subscriptionId, subscriptionId),
    )) as ProviderSubscription[];
  return findItem(rows, 'BASE_PLAN');
}

/**
 * Whether a provider's refusal to cancel means there is nothing left to
 * cancel: Stripe's `resource_missing` ("No such subscription") or its
 * refusal to touch a subscription already canceled, and Lemon Squeezy's 404
 * (its client folds the status into the message). Anything else - a
 * timeout, an auth failure, a 5xx - is a real failure.
 */
export function isProviderSubscriptionGone(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === 'resource_missing') return true;
  const message = String((err as { message?: unknown }).message ?? '');
  if (/no such subscription/i.test(message)) return true;
  if (/canceled subscription|already (been )?cancell?ed/i.test(message)) {
    return true;
  }
  // LemonSqueezyClient: "Lemon Squeezy DELETE subscriptions/1 failed: HTTP 404"
  // or the detail LS sends for a missing record.
  return /^Lemon Squeezy /.test(message) && /HTTP 404|not found/i.test(message);
}

export interface CreateSubscriptionDto {
  workspaceId: string;
  userId: string;
  planCode: string;
  paymentMethodId?: string;
  trialPeriodDays?: number;
}

export interface SubscriptionResponse {
  subscriptionId: number;
  stripeSubscriptionId: string;
  planCode: string;
  status: string;
  currentPeriodEnd: Date | null;
  clientSecret?: string;
  limits: {
    channels: number;
    members: number;
    workspaces: number;
  };
}

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(
    private stripeService: StripeService,
    private customerService: CustomerService,
    private lookup: SubscriptionLookupService,
    private readonly providers: ProviderRegistryService,
  ) {}

  async createSubscription(
    dto: CreateSubscriptionDto,
  ): Promise<SubscriptionResponse> {
    // 0. This path is Stripe-only by construction: it takes a raw
    //    `paymentMethodId`, creates the subscription server-side, and writes
    //    `stripe_subscription_id` / `stripe_subscription_item_id` columns.
    //    Lemon Squeezy has no equivalent — a subscription can only begin at a
    //    hosted checkout there — so the abstraction has no `createSubscription`
    //    operation to route to. Refuse BEFORE touching Stripe rather than
    //    after: `getOrCreateStripeCustomer` used to run unconditionally on the
    //    line below, so a Lemon Squeezy signup created a Stripe customer and
    //    wrote `stripe_customer_id` to our database, silently and with no
    //    error. Non-Stripe accounts are sent to Checkout, which IS routed.
    //
    //    FREE IS EXEMPT, and that exemption is load-bearing. A FREE
    //    subscription moves no money and touches no provider:
    //    `createFreeSubscription` writes a local row and the usage limits,
    //    and that is all. Refusing it because the ACCOUNT's provider is not
    //    Stripe left every new workspace on a Paddle (or Lemon Squeezy)
    //    deployment with NO subscription row — `WorkspaceService` only logs
    //    the failure, so the workspace was created and nothing looked wrong.
    //
    //    The absence surfaced later and far worse: a customer paid, the
    //    `subscription.created` webhook arrived, and `createRowFromCheckout`
    //    found no row to attach the Paddle subscription to. The payment
    //    bought nothing. Caught end to end in sandbox, 2026-11-26.
    const isFree = dto.planCode === 'FREE';
    if (!isFree) {
      const provider = await this.providers.providerForUser(dto.userId);
      if (provider !== 'stripe') {
        throw new BadRequestException(
          `Direct subscription creation is not supported for ${provider} — ` +
            'start a checkout session instead.',
        );
      }
    }

    // 1. Get or create Stripe customer — for a PAID subscription only. A FREE
    //    row needs no customer anywhere (`subscriptions.stripe_customer_id` is
    //    nullable), and creating one here would reintroduce exactly what the
    //    guard above exists to prevent: a Paddle or Lemon Squeezy signup
    //    silently acquiring a Stripe customer.
    const stripeCustomerId = isFree
      ? null
      : (await this.customerService.getOrCreateStripeCustomer(dto.userId))
          .stripeCustomerId;

    // 2. Validate workspace exists and user is owner
    const ws = await db
      .select()
      .from(workspace)
      .where(
        and(
          eq(workspace.id, dto.workspaceId),
          eq(workspace.ownerId, dto.userId),
          liveWorkspaces(),
        ),
      )
      .limit(1);

    if (ws.length === 0) {
      throw new NotFoundException(
        'Workspace not found or you are not the owner',
      );
    }

    // 3. Check if the account (owner) already has a subscription — a
    //    subscription is per-account now, not per-workspace.
    const existingSub = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, dto.userId))
      .limit(1);

    if (existingSub.length > 0) {
      throw new BadRequestException('You already have a subscription');
    }

    // 4. Get plan details
    const plan = await db
      .select()
      .from(plans)
      .where(eq(plans.code, dto.planCode))
      .limit(1);

    if (plan.length === 0) {
      throw new NotFoundException('Plan not found');
    }

    const selectedPlan = plan[0];

    // 5. Handle FREE plan (no Stripe subscription needed)
    if (dto.planCode === 'FREE') {
      const ownedWorkspaces = await db
        .select({ id: workspace.id, createdAt: workspace.createdAt })
        .from(workspace)
        .where(and(eq(workspace.ownerId, dto.userId), liveWorkspaces()))
        .orderBy(workspace.createdAt, workspace.id);

      return await this.createFreeSubscription(
        dto.userId,
        ownedWorkspaces,
        stripeCustomerId,
        selectedPlan,
      );
    }

    // 6. Read the provisioned Stripe price for the plan (read-only — prices are
    //    provisioned out-of-band by the stripe-provision script; FREE returned
    //    above at step 5, so only paid plans reach here).
    const stripePriceId = selectedPlan.stripePriceId;

    if (!stripePriceId) {
      throw new BadRequestException(
        `Plan "${selectedPlan.code}" is not provisioned in Stripe — run the pricing provision script (npx ts-node src/drizzle/seeds/stripe-provision.ts)`,
      );
    }

    // 7. Attach the card and create the Stripe subscription. The Stripe calls
    //    live inside the provider boundary (`stripe-direct-subscribe.util`)
    //    because this direct path has no Lemon Squeezy equivalent and so
    //    cannot be one of the abstracted operations — step 0 already refused
    //    non-Stripe accounts.
    // FREE returned at step 5, so `stripeCustomerId` is non-null from here on.
    // Asserted rather than assumed: a future edit that moves the FREE branch
    // would otherwise send `null` into Stripe and fail inside their API.
    if (!stripeCustomerId) {
      throw new InternalServerErrorException(
        'A paid subscription reached the Stripe call with no customer id.',
      );
    }

    const stripeSubscription = await createStripeSubscriptionDirect(
      this.stripeService,
      {
        stripeCustomerId,
        stripePriceId,
        paymentMethodId: dto.paymentMethodId,
        metadata: {
          workspaceId: dto.workspaceId,
          userId: dto.userId,
          planCode: dto.planCode,
        },
        trialPeriodDays: dto.trialPeriodDays,
      },
    );

    // 8. Save subscription to database (per-account, not per-workspace)
    const sub: any = stripeSubscription;
    const subscriptionData: any = {
      userId: dto.userId,
      stripeCustomerId,
      stripeSubscriptionId: stripeSubscription.id,
      planCode: dto.planCode,
      status: stripeSubscription.status,
      currentPeriodStart: new Date(sub.current_period_start * 1000),
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
    };
    // Only add trialEnd if it exists (avoid explicit null for timestamps)
    if (sub.trial_end) {
      subscriptionData.trialEnd = new Date(sub.trial_end * 1000);
    }
    const [newSubscription] = await db
      .insert(subscriptions)
      .values(subscriptionData as NewSubscription)
      .returning();

    // 8b. Write the provider record alongside it. Same reason as in
    // `persistStripeSubscription`: `hasLiveBasePlan()` reads
    // `provider_subscriptions`, so a subscription created here without one is
    // a subscription the cancel path will refuse to cancel while Stripe keeps
    // billing it.
    await writeStripeBasePlanRow({
      subscriptionId: newSubscription.id,
      stripeSubscription,
      stripeCustomerId,
      unitPriceCents: selectedPlan.basePriceCents,
    });

    // 9. Create subscription item for base plan
    await db.insert(subscriptionItems).values({
      subscriptionId: newSubscription.id,
      stripeSubscriptionItemId: stripeSubscription.items.data[0].id,
      itemType: 'BASE_PLAN',
      stripePriceId: stripePriceId,
      quantity: 1,
      unitPriceCents: selectedPlan.basePriceCents,
    } as NewSubscriptionItem);

    // 10. Initialize workspace usage for every workspace this account owns —
    // one subscription now sets limits for all of them (fan-out per the
    // primary-workspace rule: only the oldest gets channels/members).
    const ownedWorkspacesForUsage = await db
      .select({ id: workspace.id, createdAt: workspace.createdAt })
      .from(workspace)
      .where(and(eq(workspace.ownerId, dto.userId), liveWorkspaces()))
      .orderBy(workspace.createdAt, workspace.id);

    const initialUsageRows = buildUsageFanout(
      ownedWorkspacesForUsage,
      {
        channelsPerWorkspace: selectedPlan.channelsPerWorkspace,
        membersPerWorkspace: selectedPlan.membersPerWorkspace,
        maxWorkspaces: selectedPlan.maxWorkspaces,
        aiTokensPerMonth: selectedPlan.aiTokensPerMonth,
        queuedPostsPerChannel: selectedPlan.queuedPostsPerChannel,
        storageBytesPerWorkspace: selectedPlan.storageBytesPerWorkspace,
      },
      {
        extraChannels: 0,
        extraMembers: 0,
        extraWorkspaces: 0,
        extraAiTokens: 0,
      },
    );

    for (const row of initialUsageRows) {
      await db.insert(workspaceUsage).values({
        ...row,
        channelsCount: 0,
        extraChannelsPurchased: 0,
        membersCount: 0,
        extraMembersPurchased: 0,
        aiTokensResetDate: getNextTokenResetDate(),
      } as NewWorkspaceUsage);
    }

    // 11. Extract client secret for frontend
    const latestInvoice: any = sub.latest_invoice;
    const clientSecret = latestInvoice?.payment_intent?.client_secret;

    return {
      subscriptionId: newSubscription.id,
      stripeSubscriptionId: stripeSubscription.id,
      planCode: dto.planCode,
      status: stripeSubscription.status,
      currentPeriodEnd: newSubscription.currentPeriodEnd,
      clientSecret: clientSecret || undefined,
      limits: {
        channels: selectedPlan.channelsPerWorkspace,
        members: selectedPlan.membersPerWorkspace,
        workspaces: selectedPlan.maxWorkspaces,
      },
    };
  }

  private async createFreeSubscription(
    userId: string,
    workspaces: { id: string; createdAt: Date }[],
    // Null on a non-Stripe account: a FREE row needs no customer at any
    // provider, and the column is nullable.
    stripeCustomerId: string | null,
    plan: typeof plans.$inferSelect,
  ): Promise<SubscriptionResponse> {
    // Create local subscription record without Stripe subscription
    // Note: Omit null timestamp fields instead of explicitly setting them to avoid Drizzle timestamp issues
    const [newSubscription] = await db
      .insert(subscriptions)
      .values({
        userId,
        stripeCustomerId,
        planCode: 'FREE',
        status: 'active',
        currentPeriodStart: new Date(),
      } as NewSubscription)
      .returning();

    // Initialize workspace usage for every workspace the account owns — a
    // single subscription now sets limits for all of them (fanned out per
    // the primary-workspace rule: only the oldest gets channels/members).
    const usageRows = buildUsageFanout(
      workspaces,
      {
        channelsPerWorkspace: plan.channelsPerWorkspace,
        membersPerWorkspace: plan.membersPerWorkspace,
        maxWorkspaces: plan.maxWorkspaces,
        aiTokensPerMonth: plan.aiTokensPerMonth,
        queuedPostsPerChannel: plan.queuedPostsPerChannel,
        storageBytesPerWorkspace: plan.storageBytesPerWorkspace,
      },
      {
        extraChannels: 0,
        extraMembers: 0,
        extraWorkspaces: 0,
        extraAiTokens: 0,
      },
    );

    for (const row of usageRows) {
      await db.insert(workspaceUsage).values({
        ...row,
        channelsCount: 0,
        extraChannelsPurchased: 0,
        membersCount: 0,
        extraMembersPurchased: 0,
        aiTokensResetDate: getNextTokenResetDate(),
      } as NewWorkspaceUsage);
    }

    return {
      subscriptionId: newSubscription.id,
      stripeSubscriptionId: 'free-plan',
      planCode: 'FREE',
      status: 'active',
      currentPeriodEnd: null,
      limits: {
        channels: plan.channelsPerWorkspace,
        members: plan.membersPerWorkspace,
        workspaces: plan.maxWorkspaces,
      },
    };
  }

  /**
   * Hard-reset the workspace's billing state back to FREE without touching
   * Stripe. Use when stripeSubscriptionId in DB points at a subscription
   * that no longer exists on Stripe (test data wipe, account swap, mode
   * mismatch). After reset the user can re-subscribe through the normal
   * flow — which on a clean slate forces them to add a card first.
   */
  async resetBillingState(
    workspaceId: string,
    userId: string,
  ): Promise<{ success: true; message: string }> {
    const ws = await db
      .select()
      .from(workspace)
      .where(
        and(
          eq(workspace.id, workspaceId),
          eq(workspace.ownerId, userId),
          liveWorkspaces(),
        ),
      )
      .limit(1);

    if (ws.length === 0) {
      throw new NotFoundException(
        'Workspace not found or you are not the owner',
      );
    }

    // Wipe subscription items first (FK to subscriptions). Subscriptions are
    // per-account now, so reset the (already-verified) owner's subscription.
    const sub = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .limit(1);

    if (sub.length > 0) {
      await db
        .delete(subscriptionItems)
        .where(eq(subscriptionItems.subscriptionId, sub[0].id));

      // Reset subscription row to FREE / clean state
      await db
        .update(subscriptions)
        .set({
          planCode: 'FREE',
          status: 'active',
          stripeSubscriptionId: null,
          currentPeriodStart: new Date(),
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.id, sub[0].id));

      // ...and end the PROVIDER rows, which hold the same fact in the table
      // the billing branches actually read. This endpoint nulls
      // `stripe_subscription_id` exactly like `handleSubscriptionDeleted`
      // does, and had exactly the same hole: the reset account kept a
      // BASE_PLAN row at `provider_status = 'active'`, `is_default = true`,
      // so `hasLiveBasePlan()` still answered TRUE and the re-subscribe this
      // endpoint EXISTS to unblock handed Stripe the dead id and 500'd with
      // `resource_missing`. Nulling the column no longer clears the state on
      // its own, and `clearStaleStripeSubscription` cannot recover it
      // afterwards because it early-returns on the null column.
      await endStripeProviderRows(sub[0].id);
    }

    return {
      success: true,
      message:
        'Billing state reset. You are now on the Free plan — pick a paid plan and add a payment method to upgrade.',
    };
  }

  async createCheckoutSession(dto: {
    workspaceId: string;
    userId: string;
    planCode: string;
  }): Promise<{ url: string }> {
    // 1. Validate workspace exists and user is owner (mirror createSubscription).
    const ws = await db
      .select()
      .from(workspace)
      .where(
        and(
          eq(workspace.id, dto.workspaceId),
          eq(workspace.ownerId, dto.userId),
          liveWorkspaces(),
        ),
      )
      .limit(1);
    if (ws.length === 0) {
      throw new NotFoundException(
        'Workspace not found or you are not the owner',
      );
    }

    // 2. Resolve the plan and ensure it is paid. The provider-specific price
    //    reference (Stripe price id / Lemon Squeezy variant id) is resolved
    //    inside the adapter via the catalogue — reading `stripePriceId` here
    //    would have made a Lemon Squeezy checkout fail on a column it never
    //    populates.
    const planRows = await db
      .select()
      .from(plans)
      .where(eq(plans.code, dto.planCode))
      .limit(1);
    const plan = planRows[0];
    if (!plan) throw new NotFoundException('Plan not found');
    if (plan.basePriceCents <= 0) {
      throw new BadRequestException('FREE plan does not require checkout');
    }

    // 3. Hand off to whichever provider bills this account. The Stripe
    //    customer is created inside `StripeAdapter.createCheckout` and ONLY
    //    there — it used to be created unconditionally right here, which meant
    //    a Lemon Squeezy signup silently got a `stripe_customer_id`.
    const adapter = await this.providers.adapterFor(dto.userId);
    return await adapter.createCheckout(
      dto.userId,
      dto.planCode,
      dto.workspaceId,
    );
  }

  /**
   * Idempotently persist a Stripe subscription into our DB (subscriptions +
   * BASE_PLAN item + a workspace_usage row per owned workspace). Used by the
   * checkout webhook and any direct path. Upserts on the account's existing
   * row (FREE→paid updates the pre-existing FREE row rather than inserting a
   * duplicate) — a subscription is per-account now, not per-workspace.
   */
  async persistStripeSubscription(input: {
    userId: string;
    planCode: string;
    stripeCustomerId: string;
    stripeSubscription: Stripe.Subscription;
  }): Promise<void> {
    const planRows = await db
      .select()
      .from(plans)
      .where(eq(plans.code, input.planCode))
      .limit(1);
    const plan = planRows[0];
    if (!plan) {
      throw new NotFoundException(`Plan "${input.planCode}" not found`);
    }

    // Deterministic order (createdAt, then id) so "primary workspace" never
    // shifts between calls when two workspaces share a createdAt timestamp.
    const workspaces = await db
      .select({ id: workspace.id, createdAt: workspace.createdAt })
      .from(workspace)
      .where(and(eq(workspace.ownerId, input.userId), liveWorkspaces()))
      .orderBy(workspace.createdAt, workspace.id);

    const existingSubForAddons = await this.lookup.findByUserId(input.userId);
    const addons = existingSubForAddons
      ? await this.lookup.getAddonQuantities(existingSubForAddons.id)
      : {
          extraChannels: 0,
          extraMembers: 0,
          extraWorkspaces: 0,
          extraAiTokens: 0,
        };

    const planLimits = {
      channelsPerWorkspace: plan.channelsPerWorkspace,
      membersPerWorkspace: plan.membersPerWorkspace,
      maxWorkspaces: plan.maxWorkspaces,
      aiTokensPerMonth: plan.aiTokensPerMonth,
      queuedPostsPerChannel: plan.queuedPostsPerChannel,
      storageBytesPerWorkspace: plan.storageBytesPerWorkspace,
    };

    const { subscriptionRow, baseItem, usageRows } = buildSubscriptionSync({
      userId: input.userId,
      workspaces,
      planCode: input.planCode,
      plan: { ...planLimits, basePriceCents: plan.basePriceCents },
      addons,
      stripeCustomerId: input.stripeCustomerId,
      stripeSubscription: input.stripeSubscription,
    });

    // 1. Upsert the subscriptions row (UNIQUE user_id → updates FREE row).
    const subSet: Record<string, unknown> = {
      stripeCustomerId: sql`excluded.stripe_customer_id`,
      stripeSubscriptionId: sql`excluded.stripe_subscription_id`,
      planCode: sql`excluded.plan_code`,
      status: sql`excluded.status`,
      currentPeriodStart: sql`excluded.current_period_start`,
      currentPeriodEnd: sql`excluded.current_period_end`,
      cancelAtPeriodEnd: sql`excluded.cancel_at_period_end`,
      updatedAt: new Date(),
    };
    if ('trialEnd' in subscriptionRow) {
      subSet.trialEnd = sql`excluded.trial_end`;
    }
    await db
      .insert(subscriptions)
      .values(subscriptionRow as NewSubscription)
      .onConflictDoUpdate({ target: subscriptions.userId, set: subSet });

    // 2. Get the subscription id for the item upsert.
    const savedRows = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(eq(subscriptions.userId, input.userId))
      .limit(1);
    const subscriptionId = savedRows[0].id;

    // 2b. Write the provider record. `provider_subscriptions` is the table
    // `hasLiveBasePlan()` reads to decide whether this account is being billed
    // — the provider-neutral replacement for `if (sub.stripeSubscriptionId)`.
    // Nothing wrote the BASE_PLAN row before this, so every branch keyed on it
    // read "unbilled" for real Stripe subscribers: `downgradeToFree` returned
    // without cancelling (Stripe charged on), and a paid→paid `changePlan`
    // created a SECOND live subscription. Idempotent, because Stripe
    // redelivers `checkout.session.completed`.
    await writeStripeBasePlanRow({
      subscriptionId,
      stripeSubscription: input.stripeSubscription,
      stripeCustomerId: input.stripeCustomerId,
      unitPriceCents: plan.basePriceCents,
    });

    // 3. Upsert the BASE_PLAN item (UNIQUE subscription_id + item_type).
    await db
      .insert(subscriptionItems)
      .values({ ...baseItem, subscriptionId } as NewSubscriptionItem)
      .onConflictDoUpdate({
        target: [subscriptionItems.subscriptionId, subscriptionItems.itemType],
        set: {
          stripeSubscriptionItemId: sql`excluded.stripe_subscription_item_id`,
          stripePriceId: sql`excluded.stripe_price_id`,
          quantity: sql`excluded.quantity`,
          unitPriceCents: sql`excluded.unit_price_cents`,
          updatedAt: new Date(),
        },
      });

    // 4. Upsert workspace_usage limits (UNIQUE workspace_id) — one row per
    // owned workspace, since one subscription now covers all of them.
    for (const usageRow of usageRows) {
      await db
        .insert(workspaceUsage)
        .values({
          ...usageRow,
          aiTokensResetDate: getNextTokenResetDate(),
        } as NewWorkspaceUsage)
        .onConflictDoUpdate({
          target: workspaceUsage.workspaceId,
          set: {
            channelsLimit: sql`excluded.channels_limit`,
            membersLimit: sql`excluded.members_limit`,
            aiTokensLimit: sql`excluded.ai_tokens_limit`,
            storageBytesLimit: sql`excluded.storage_bytes_limit`,
            updatedAt: new Date(),
            // aiTokensResetDate is deliberately NOT updated here. It seeds a
            // brand-new row only; carrying it into the conflict branch would
            // push every existing workspace's rollover forward on every plan
            // or add-on change, handing out a fresh allowance each time.
          },
        });
    }

    // 5. Persist the subscription's first invoice now, while we hold the fully
    // expanded Stripe subscription (getSubscription expands `latest_invoice`).
    // Stripe often emits `invoice.*` webhooks BEFORE `checkout.session.completed`,
    // so relying on those events alone would miss the signup invoice (the sub
    // row doesn't exist yet when they arrive). Capturing it here makes checkout
    // the authoritative path, independent of webhook ordering.
    const latestInvoice = input.stripeSubscription.latest_invoice;
    if (latestInvoice && typeof latestInvoice !== 'string') {
      await upsertInvoiceFromStripe(latestInvoice, subscriptionId);
    }
  }

  async getSubscriptionByWorkspaceId(workspaceId: string) {
    const subscription = await this.lookup.findByWorkspaceId(workspaceId);
    if (!subscription) {
      throw new NotFoundException('Subscription not found for this workspace');
    }
    return subscription;
  }

  /**
   * Pause billing without tearing anything down.
   *
   * The category's cautionary tale is Publer, whose downgrade-to-free deletes
   * scheduled posts; its own help centre tells users to pause instead. Offering
   * pause directly gives a price-sensitive or seasonal customer somewhere to go
   * that is not cancellation, and costs us nothing to hold.
   *
   * Limits drop to FREE for the duration — they are not paying — so channels
   * over the free ceiling lock rather than disconnect, and resuming brings
   * them straight back.
   */
  async pauseSubscription(
    userId: string,
  ): Promise<{ message: string; pausedAt: Date }> {
    const subscription = await this.lookup.findByUserId(userId);

    if (!subscription) {
      throw new NotFoundException('No subscription to pause');
    }

    if (subscription.planCode === 'FREE') {
      throw new BadRequestException('A free plan has nothing to pause');
    }

    if (subscription.status === 'paused') {
      throw new BadRequestException('Subscription is already paused');
    }

    const adapter = await this.providers.adapterForSubscription(
      subscription.id,
    );
    await adapter.pause(subscription.id);

    const pausedAt = new Date();

    await db
      .update(subscriptions)
      .set({ status: 'paused', updatedAt: pausedAt })
      .where(eq(subscriptions.id, subscription.id));

    // FREE limits while paused. Nothing is deleted: over-ceiling channels lock
    // and come back on resume.
    await this.lookup.applyLimitsToAllWorkspaces(userId, 'FREE', {
      extraChannels: 0,
      extraMembers: 0,
      extraWorkspaces: 0,
      extraAiTokens: 0,
    });

    return {
      message:
        'Subscription paused. Nothing was deleted — resume any time to restore your plan.',
      pausedAt,
    };
  }

  /** Resume a paused subscription and restore the plan's limits. */
  async resumeSubscription(userId: string): Promise<{ message: string }> {
    const subscription = await this.lookup.findByUserId(userId);

    if (!subscription) {
      throw new NotFoundException('No subscription to resume');
    }

    if (subscription.status !== 'paused') {
      throw new BadRequestException('Subscription is not paused');
    }

    const adapter = await this.providers.adapterForSubscription(
      subscription.id,
    );
    await adapter.resume(subscription.id);

    await db
      .update(subscriptions)
      .set({ status: 'active', updatedAt: new Date() })
      .where(eq(subscriptions.id, subscription.id));

    const addons = await this.lookup.getAddonQuantities(subscription.id);
    await this.lookup.applyLimitsToAllWorkspaces(
      userId,
      subscription.planCode,
      addons,
    );

    return {
      message: 'Subscription resumed. Your plan and channels are back.',
    };
  }

  async cancelSubscription(
    workspaceId: string,
    userId: string,
    cancelAtPeriodEnd: boolean = true,
    reason?: CancelReason,
  ): Promise<{ message: string }> {
    // Verify ownership
    const ws = await db
      .select()
      .from(workspace)
      .where(
        and(
          eq(workspace.id, workspaceId),
          eq(workspace.ownerId, userId),
          liveWorkspaces(),
        ),
      )
      .limit(1);

    if (ws.length === 0) {
      throw new NotFoundException(
        'Workspace not found or you are not the owner',
      );
    }

    // Read here as well as in cancelForAccount: the route keeps its own
    // answers (404 without a subscription, 400 on FREE, the period end in
    // the message), which 'none' alone cannot tell apart.
    const subscription = await this.accountSubscription(userId);

    if (!subscription) {
      throw new NotFoundException('Subscription not found for this workspace');
    }

    // Handle FREE plan
    if (subscription.planCode === 'FREE') {
      throw new BadRequestException('Cannot cancel free plan');
    }

    const outcome = await this.cancelForAccount(userId, cancelAtPeriodEnd, {
      reason,
      changedByUserId: userId,
    });
    if (outcome === 'none') {
      throw new BadRequestException(
        cancelAtPeriodEnd && subscription.cancelAtPeriodEnd
          ? 'Subscription is already set to cancel at the end of the billing period'
          : 'Subscription is already canceled',
      );
    }

    return cancelAtPeriodEnd
      ? {
          message: `Subscription will be canceled at the end of the billing period (${subscription.currentPeriodEnd})`,
        }
      : { message: 'Subscription canceled immediately' };
  }

  /**
   * Cancels the account's subscription at whichever provider bills it, with
   * no workspace in the picture: the route above, deleting the last owned
   * workspace, and deleting the account all come here. 'none' when there is
   * nothing to cancel (isCancellable: no subscription, FREE, already
   * canceled, or already ending at the period end when that is asked again);
   * the provider is never called and nothing is logged then.
   *
   * Every cancel is logged in `subscription_changes` with the reason, so a
   * churn report can read why.
   */
  async cancelForAccount(
    userId: string,
    atPeriodEnd: boolean,
    opts: {
      reason?: CancelReason;
      changedByUserId?: string | null;
      /**
       * The provider says the subscription is already gone (cancelled, or
       * no such subscription): treat it as cancelled here too instead of
       * failing. Account deletion sets it - a subscription that no longer
       * bills must not block deleting the account.
       */
      goneIsCancelled?: boolean;
    } = {},
  ): Promise<'cancelled' | 'none'> {
    const subscription = await this.accountSubscription(userId);
    if (
      !subscription ||
      !isCancellable(
        subscription,
        atPeriodEnd,
        await loadBasePlanRow(db, subscription.id),
      )
    ) {
      return 'none';
    }

    const adapter = await this.providers.adapterForSubscription(
      subscription.id,
    );
    try {
      await adapter.cancel(subscription.id, atPeriodEnd);
    } catch (error) {
      if (!opts.goneIsCancelled || !isProviderSubscriptionGone(error)) {
        throw error;
      }
      this.logger.warn(
        `Subscription ${subscription.id}: the provider has nothing left to cancel (${(error as Error)?.message}); recorded as cancelled`,
      );
    }

    await db
      .update(subscriptions)
      .set(
        atPeriodEnd
          ? { cancelAtPeriodEnd: true, updatedAt: new Date() }
          : {
              status: 'canceled',
              canceledAt: new Date(),
              updatedAt: new Date(),
            },
      )
      .where(eq(subscriptions.id, subscription.id));

    await db.insert(subscriptionChanges).values({
      subscriptionId: subscription.id,
      changeType: 'SUBSCRIPTION_CANCELLED',
      newValue: { atPeriodEnd },
      changedByUserId: opts.changedByUserId ?? null,
      reason: opts.reason ?? null,
    });

    return 'cancelled';
  }

  /** Subscriptions are per account: one row per user. */
  private async accountSubscription(userId: string) {
    return db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .limit(1)
      .then((rows) => rows[0]);
  }
}
