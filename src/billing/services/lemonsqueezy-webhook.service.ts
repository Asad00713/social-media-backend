import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import {
  providerSubscriptions,
  subscriptions,
  subscriptionItems,
  ProviderItemType,
} from '../../drizzle/schema';
import { SubscriptionLookupService } from './subscription-lookup.service';
import { mapLemonSqueezyStatus } from '../providers/lemonsqueezy-status.util';

const PROVIDER = 'lemonsqueezy' as const;

/**
 * Lemon Squeezy statuses that genuinely END a subscription.
 *
 * Deliberately NOT a mirror of `mapLemonSqueezyStatus`. `cancelled` maps onto
 * our `active` + `cancelAtPeriodEnd` and the customer keeps access until
 * `ends_at`, so it must NOT appear here — treating it as terminal would revoke
 * a paying customer the moment they schedule a cancellation, and would release
 * the `is_default` slot while Lemon Squeezy is still billing them.
 *
 * `expired` is the only status Lemon Squeezy uses for "access is over". Their
 * docs are explicit that customers keep access in every other status, and
 * `isLive()` in `provider-subscription.util.ts` already encodes exactly this.
 *
 * Enumerated explicitly, in the same spirit as that deny-list: adding a status
 * here is a deliberate act, never an inference from a word.
 */
const LS_TERMINAL_STATUSES = new Set(['expired']);

/** The item types an add-on event can concern. */
const ADDON_ITEM_TYPES: ProviderItemType[] = [
  'EXTRA_CHANNEL',
  'EXTRA_MEMBER',
  'EXTRA_WORKSPACE',
  'EXTRA_AI_TOKENS',
];

/** Lifecycle events carry a Subscription object. */
const LIFECYCLE_EVENTS = new Set([
  'subscription_created',
  'subscription_updated',
  'subscription_cancelled',
  'subscription_resumed',
  'subscription_expired',
  'subscription_paused',
  'subscription_unpaused',
]);

/** Payment events carry a subscription INVOICE — a different payload shape. */
const PAYMENT_EVENTS = new Set([
  'subscription_payment_success',
  'subscription_payment_failed',
  'subscription_payment_recovered',
  'subscription_payment_refunded',
]);

/** The JSON:API envelope, as far as this service reads it. */
interface LsEnvelope {
  meta?: {
    event_name?: string;
    custom_data?: Record<string, unknown>;
  };
  data?: {
    id?: string | number;
    type?: string;
    attributes?: LsSubscriptionAttributes & LsInvoiceAttributes;
  };
}

interface LsSubscriptionAttributes {
  status?: string;
  ends_at?: string | null;
  renews_at?: string | null;
  customer_id?: string | number | null;
  variant_id?: string | number | null;
  first_subscription_item?: {
    id?: string | number;
    quantity?: number;
  } | null;
}

interface LsInvoiceAttributes {
  /** On a subscription-invoice payload this names the subscription. */
  subscription_id?: string | number | null;
}

/** What a webhook was resolved down to before anything is written. */
interface Target {
  /** `provider_subscriptions.id`. */
  rowId: number;
  /** Our `subscriptions.id`. */
  subscriptionId: number;
  /** Read from the ROW, never inferred from a variant id. */
  itemType: string;
  isDefault: boolean;
  providerStatus: string | null;
}

/**
 * Lemon Squeezy webhooks.
 *
 * Two things this class exists to get right, both learned expensively on this
 * branch:
 *
 * 1. **`cancelled` is not dead.** Lemon Squeezy's `cancelled` means the
 *    customer keeps access until `ends_at`; only `expired` revokes. Every
 *    branch here tests `LS_TERMINAL_STATUSES`, never the word.
 *
 * 2. **Anything that ends a subscription must leave `provider_subscriptions`
 *    telling the truth.** The Stripe handler nulled `stripe_subscription_id`
 *    and left its provider row reading `active` / `is_default = true`, so the
 *    account read as FREE locally while holding a live-looking row naming a
 *    subscription that no longer existed — and could never re-subscribe,
 *    because the one `is_default` slot the partial unique index allows stayed
 *    occupied. The equivalent here is `expired`: it writes the row dead AND
 *    releases `is_default`, exactly as `endStripeProviderRows` does.
 *    `cancelled`/`paused`/`past_due` deliberately KEEP the flag — Lemon
 *    Squeezy is still the provider billing this account.
 *
 * Ordering is NOT guaranteed. Every write is gated so a stale event cannot
 * resurrect a dead row: a row already in a terminal status refuses to move out
 * of it, so a late `subscription_updated` carrying `active` that overtook an
 * `expired` cannot bring a terminated account back to life.
 */
@Injectable()
export class LemonSqueezyWebhookService {
  private readonly logger = new Logger(LemonSqueezyWebhookService.name);

  constructor(private readonly lookup: SubscriptionLookupService) {}

  // -------------------------------------------------------------- signature

  /**
   * HMAC-SHA256 over the RAW body, compared in constant time.
   *
   * The raw bytes matter: `JSON.parse` then `JSON.stringify` reorders keys and
   * changes whitespace, so a signature computed over a re-serialised body
   * never matches. The route reads `req.rawBody`, exactly as the Stripe route
   * does.
   *
   * Returns FALSE when the secret is unset. Returning true — or skipping
   * verification "because it is not configured yet" — would leave an unsigned,
   * publicly reachable endpoint that mutates billing state on demand. An
   * unconfigured environment must reject webhooks, not accept forged ones.
   *
   * `timingSafeEqual` throws when the two buffers differ in length, and a
   * malformed hex string produces a short (or empty) buffer, so both the
   * length check and the try/catch are load-bearing: a garbage header must
   * produce `false`, never a 500 that Lemon Squeezy then retries forever.
   */
  verifySignature(raw: Buffer, signature: string): boolean {
    const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
    if (!secret) {
      this.logger.error(
        'LEMONSQUEEZY_WEBHOOK_SECRET is not set; rejecting the webhook rather ' +
          'than trusting an unverified body.',
      );
      return false;
    }
    if (!signature) return false;

    try {
      const expected = crypto.createHmac('sha256', secret).update(raw).digest();
      const received = Buffer.from(signature, 'hex');
      if (received.length !== expected.length) return false;
      return crypto.timingSafeEqual(expected, received);
    } catch {
      return false;
    }
  }

  // ----------------------------------------------------------------- events

  async handleEvent(eventName: string, payload: unknown): Promise<void> {
    const envelope = (payload ?? {}) as LsEnvelope;

    if (LIFECYCLE_EVENTS.has(eventName)) {
      await this.handleLifecycle(eventName, envelope);
      return;
    }
    if (PAYMENT_EVENTS.has(eventName)) {
      await this.handlePayment(eventName, envelope);
      return;
    }

    this.logger.log(`Ignoring unhandled Lemon Squeezy event ${eventName}`);
  }

  // -------------------------------------------------------------- lifecycle

  /**
   * On a lifecycle event `data` IS the subscription, so `data.id` is the
   * provider subscription id.
   */
  private async handleLifecycle(
    eventName: string,
    envelope: LsEnvelope,
  ): Promise<void> {
    const providerSubscriptionId = idOf(envelope.data?.id);
    if (!providerSubscriptionId) {
      this.logger.warn(`${eventName} arrived with no subscription id`);
      return;
    }

    const attrs = envelope.data?.attributes ?? {};
    let target = await this.findTarget(providerSubscriptionId);

    // `subscription_created` is the ONLY event that may create a row: it is
    // the completion of a checkout we started. Every other event refreshes an
    // existing one, for the same reason `refreshStripeProviderRowStatus` is an
    // update and never an upsert — an event for a subscription we hold no row
    // for must not claim `is_default` for an account whose provider is not yet
    // decided.
    if (!target && eventName === 'subscription_created') {
      target = await this.createRowFromCheckout(
        providerSubscriptionId,
        envelope,
      );
    }

    if (!target) {
      this.logger.warn(
        `No Lemon Squeezy provider row for subscription ` +
          `${providerSubscriptionId} (${eventName}); nothing to update.`,
      );
      return;
    }

    await this.applyStatus(target, attrs);
  }

  /**
   * Write the provider row for a checkout that has just completed.
   *
   * `checkout_data.custom` is echoed back on `meta.custom_data`, and it is
   * where the adapter put `user_id`, `item_type` and (for an add-on) our
   * `subscription_id`. `item_type` comes from there rather than from the
   * variant id for the same reason it is a stored column: a variant map read
   * at webhook time breaks silently the first time the catalogue changes.
   */
  private async createRowFromCheckout(
    providerSubscriptionId: string,
    envelope: LsEnvelope,
  ): Promise<Target | null> {
    const custom = envelope.meta?.custom_data ?? {};
    const userId = strOf(custom['user_id']);
    const itemType = strOf(custom['item_type']) ?? 'BASE_PLAN';

    const subscriptionId = await this.resolveSubscriptionId(custom, userId);
    if (!subscriptionId) {
      this.logger.error(
        `subscription_created for ${providerSubscriptionId} carried no ` +
          `resolvable account (custom_data user_id/subscription_id missing); ` +
          `the provider row cannot be written.`,
      );
      return null;
    }

    const attrs = envelope.data?.attributes ?? {};

    // `is_default` names the provider currently billing this account, and the
    // partial unique index allows exactly ONE true row per subscription.
    // Claiming it while another row already holds it raises 23505 AFTER Lemon
    // Squeezy has taken the customer's money — the same post-charge shape as
    // the Stripe add-on defect. So it is claimed only when the account has no
    // default at all.
    const existingDefault = await db
      .select({ id: providerSubscriptions.id })
      .from(providerSubscriptions)
      .where(
        and(
          eq(providerSubscriptions.subscriptionId, subscriptionId),
          eq(providerSubscriptions.isDefault, true),
        ),
      );

    const claimsDefault = existingDefault.length === 0;

    const inserted = await db
      .insert(providerSubscriptions)
      .values({
        subscriptionId,
        provider: PROVIDER,
        itemType,
        providerSubscriptionId,
        providerCustomerId: idOf(attrs.customer_id),
        providerItemId: idOf(attrs.first_subscription_item?.id),
        providerPriceId: idOf(attrs.variant_id),
        providerQuantity: attrs.first_subscription_item?.quantity ?? 1,
        providerStatus: attrs.status ?? null,
        endsAt: dateOf(attrs.ends_at),
        renewsAt: dateOf(attrs.renews_at),
        isDefault: claimsDefault,
      })
      .returning({ id: providerSubscriptions.id });

    const rowId = (inserted as { id: number }[])[0]?.id;
    if (rowId === undefined || rowId === null) return null;

    return {
      rowId,
      subscriptionId,
      itemType,
      isDefault: claimsDefault,
      providerStatus: attrs.status ?? null,
    };
  }

  /**
   * Our `subscriptions.id` for a checkout.
   *
   * An add-on checkout carries it directly (the adapter puts it there). A base
   * plan checkout carries only `user_id`, because the account row is what the
   * checkout is FOR.
   */
  private async resolveSubscriptionId(
    custom: Record<string, unknown>,
    userId: string | null,
  ): Promise<number | null> {
    const direct = strOf(custom['subscription_id']);
    if (direct) {
      const parsed = Number(direct);
      if (Number.isFinite(parsed)) return parsed;
    }
    if (!userId) return null;
    const sub = await this.lookup.findByUserId(userId);
    return sub ? sub.id : null;
  }

  // ------------------------------------------------------------ status write

  /**
   * The single write path. Every lifecycle event funnels through here so no
   * event can update one of the tables that hold this state and forget the
   * others:
   *
   *  (a) `provider_subscriptions` — always. It is the row `isLive()` and
   *      `hasLiveBasePlan()` read to decide whether this account is billed.
   *  (b) `subscriptions` — only for BASE_PLAN, via `mapLemonSqueezyStatus`.
   *  (c) `subscription_items` — only on genuine termination.
   *  (d) workspace limits — only on genuine termination.
   */
  private async applyStatus(
    target: Target,
    attrs: LsSubscriptionAttributes,
  ): Promise<void> {
    const status = (attrs.status ?? '').toLowerCase();

    // ORDERING IS NOT GUARANTEED. A row that is already terminal must not be
    // revived by a stale event delivered late — `expired` then `active`
    // arriving out of order would otherwise resurrect a dead subscription,
    // restore the customer's limits and re-claim the `is_default` slot that a
    // fresh signup at the other provider may already have taken.
    const current = (target.providerStatus ?? '').toLowerCase();
    if (
      LS_TERMINAL_STATUSES.has(current) &&
      !LS_TERMINAL_STATUSES.has(status)
    ) {
      this.logger.warn(
        `Ignoring a stale Lemon Squeezy event: provider row ${target.rowId} ` +
          `is already ${current} and the event carries ` +
          `${status || 'no status'}.`,
      );
      return;
    }

    const terminal = LS_TERMINAL_STATUSES.has(status);

    // (a) the provider row. On genuine termination `is_default` is RELEASED —
    // the single slot the partial unique index allows must be free for
    // whatever bills this account next, exactly like `endStripeProviderRows`.
    // On `cancelled` it is deliberately KEPT: Lemon Squeezy is still billing
    // until `ends_at`, so it is still this account's provider, and dropping
    // the flag would make `findItem`/`pickDefaultProvider` lose the account's
    // live subscription mid-period.
    const providerPatch: Record<string, unknown> = {
      providerStatus: attrs.status ?? null,
      endsAt: dateOf(attrs.ends_at),
      renewsAt: dateOf(attrs.renews_at),
      updatedAt: new Date(),
    };
    if (attrs.first_subscription_item?.quantity !== undefined) {
      providerPatch.providerQuantity = attrs.first_subscription_item.quantity;
    }
    if (attrs.first_subscription_item?.id !== undefined) {
      providerPatch.providerItemId = idOf(attrs.first_subscription_item.id);
    }
    if (terminal) {
      providerPatch.isDefault = false;
      providerPatch.renewsAt = null;
      providerPatch.endsAt = dateOf(attrs.ends_at) ?? new Date();
    }

    await db
      .update(providerSubscriptions)
      .set(providerPatch)
      .where(eq(providerSubscriptions.id, target.rowId));

    if (target.itemType !== 'BASE_PLAN') {
      // An add-on that has genuinely expired stops entitling anything. Its
      // `subscription_items` row is what the rest of the app reads for
      // quantities, so leaving it in place keeps granting capacity nobody pays
      // for — the entitlement mirror of billing after cancel.
      if (terminal) {
        await this.revokeAddon(target);
      }
      return;
    }

    // (b) our own subscription row, for the base plan only. `cancelled` lands
    // here as `active` + `cancelAtPeriodEnd`, which is what our model already
    // means by "cancelled but still paid up".
    const mapped = mapLemonSqueezyStatus(attrs.status ?? '');
    const subPatch: Record<string, unknown> = {
      status: mapped.status,
      cancelAtPeriodEnd: mapped.cancelAtPeriodEnd,
      updatedAt: new Date(),
    };
    if (terminal) {
      subPatch.planCode = 'FREE';
      subPatch.cancelAtPeriodEnd = false;
      subPatch.scheduledPlanCode = null;
      subPatch.scheduledChangeAt = null;
      subPatch.canceledAt = new Date();
    }

    await db
      .update(subscriptions)
      .set(subPatch)
      .where(eq(subscriptions.id, target.subscriptionId));

    if (terminal) {
      await this.revokeBasePlan(target);
    }
  }

  /**
   * The base plan has expired: the account falls back to FREE everywhere.
   *
   * Mirrors `handleSubscriptionDeleted` on the Stripe side. The BASE_PLAN
   * provider row is already dead and de-defaulted by the caller, so this
   * closes (c) and (d) — the add-on bookkeeping rows and the workspace limits.
   * Without it the account keeps its paid limits forever while Lemon Squeezy
   * bills nothing.
   */
  private async revokeBasePlan(target: Target): Promise<void> {
    const sub = await db
      .select({ userId: subscriptions.userId })
      .from(subscriptions)
      .where(eq(subscriptions.id, target.subscriptionId));

    const userId = (sub as { userId: string }[])[0]?.userId;
    if (!userId) return;

    // The add-on items are deleted just below, so pass zeroes explicitly
    // rather than reading quantities that are about to disappear.
    await this.lookup.applyLimitsToAllWorkspaces(userId, 'FREE', {
      extraChannels: 0,
      extraMembers: 0,
      extraWorkspaces: 0,
      extraAiTokens: 0,
    });

    await db
      .delete(subscriptionItems)
      .where(eq(subscriptionItems.subscriptionId, target.subscriptionId));

    // Every Lemon Squeezy add-on is its OWN subscription, so the base plan
    // expiring does not expire them at the provider — but nothing is entitled
    // by them any more either, and their rows would otherwise go on reading as
    // live billing. Mark them dead and release any default flag they hold, so
    // the account can subscribe again through either provider.
    await db
      .update(providerSubscriptions)
      .set({
        providerStatus: 'expired',
        isDefault: false,
        renewsAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(providerSubscriptions.subscriptionId, target.subscriptionId),
          eq(providerSubscriptions.provider, PROVIDER),
        ),
      );

    this.logger.log(
      `User ${userId} reset to FREE after their Lemon Squeezy subscription ` +
        `expired`,
    );
  }

  /** One expired add-on: drop its bookkeeping row and re-apply limits. */
  private async revokeAddon(target: Target): Promise<void> {
    if (!ADDON_ITEM_TYPES.includes(target.itemType as ProviderItemType)) {
      return;
    }

    await db
      .delete(subscriptionItems)
      .where(
        and(
          eq(subscriptionItems.subscriptionId, target.subscriptionId),
          eq(subscriptionItems.itemType, target.itemType),
        ),
      );

    const sub = await db
      .select({
        userId: subscriptions.userId,
        planCode: subscriptions.planCode,
      })
      .from(subscriptions)
      .where(eq(subscriptions.id, target.subscriptionId));

    const account = (sub as { userId: string; planCode: string }[])[0];
    if (!account) return;

    const addons = await this.lookup.getAddonQuantities(target.subscriptionId);
    await this.lookup.applyLimitsToAllWorkspaces(
      account.userId,
      account.planCode,
      addons,
    );
  }

  // ---------------------------------------------------------------- payments

  /**
   * Payment events carry a subscription INVOICE, not a subscription: the
   * provider subscription id is an ATTRIBUTE (`subscription_id`) rather than
   * `data.id`, which on these payloads is the invoice's own id. Reading
   * `data.id` here would look an invoice id up in the subscription column and
   * silently find nothing at all.
   *
   * They carry no subscription status, so they never write the provider row's
   * status — `subscription_updated` follows every one of them and is the
   * authority for that. What they do move is our own dunning state on the base
   * plan: a failure is `past_due`, a success or recovery is `active` again.
   *
   * A refund deliberately changes nothing: refunding an invoice does not end
   * the subscription at Lemon Squeezy, and the `subscription_*` event that
   * follows a real termination is what revokes access.
   */
  private async handlePayment(
    eventName: string,
    envelope: LsEnvelope,
  ): Promise<void> {
    const providerSubscriptionId = idOf(
      envelope.data?.attributes?.subscription_id,
    );
    if (!providerSubscriptionId) {
      this.logger.warn(
        `${eventName} arrived with no subscription_id attribute; ignoring.`,
      );
      return;
    }

    const target = await this.findTarget(providerSubscriptionId);
    if (!target) {
      this.logger.warn(
        `No Lemon Squeezy provider row for subscription ` +
          `${providerSubscriptionId} (${eventName}).`,
      );
      return;
    }

    // Add-on invoices say nothing about the account's own status.
    if (target.itemType !== 'BASE_PLAN') return;

    // A terminal row stays terminal. A late payment event must not move an
    // expired account back to `active`.
    if (LS_TERMINAL_STATUSES.has((target.providerStatus ?? '').toLowerCase())) {
      return;
    }

    if (eventName === 'subscription_payment_refunded') return;

    const status =
      eventName === 'subscription_payment_failed' ? 'past_due' : 'active';

    await db
      .update(subscriptions)
      .set({ status, updatedAt: new Date() })
      .where(eq(subscriptions.id, target.subscriptionId));
  }

  // ------------------------------------------------------------------ shared

  /**
   * Resolve a provider subscription id to the row that owns it, and read
   * `item_type` FROM THAT ROW.
   *
   * The whole routing decision — base plan or add-on — is this column. It is
   * never derived from `variant_id`: a variant map read at webhook time breaks
   * silently the first time the catalogue changes, and the failure would be an
   * add-on event applying base-plan semantics (or the reverse) to a live
   * account.
   */
  private async findTarget(
    providerSubscriptionId: string,
  ): Promise<Target | null> {
    const rows = await db
      .select({
        rowId: providerSubscriptions.id,
        subscriptionId: providerSubscriptions.subscriptionId,
        itemType: providerSubscriptions.itemType,
        isDefault: providerSubscriptions.isDefault,
        providerStatus: providerSubscriptions.providerStatus,
      })
      .from(providerSubscriptions)
      .where(
        and(
          eq(providerSubscriptions.provider, PROVIDER),
          eq(
            providerSubscriptions.providerSubscriptionId,
            providerSubscriptionId,
          ),
        ),
      );

    return (rows as Target[])[0] ?? null;
  }
}

/**
 * Lemon Squeezy sends ids as numbers in some payloads and strings in others.
 *
 * Narrowed to primitives on purpose. A bare `String(value)` turns an object
 * into the literal `'[object Object]'`, which would then be written into
 * `provider_subscription_id` and looked up by later webhooks as though it were
 * a real id — a lookup that silently matches nothing, or worse, collides with
 * another account that suffered the same coercion.
 */
function idOf(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return String(value);
  return null;
}

function strOf(value: unknown): string | null {
  if (typeof value !== 'string') return idOf(value);
  return value.length > 0 ? value : null;
}

function dateOf(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
