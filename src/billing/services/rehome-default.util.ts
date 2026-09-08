import { Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db as defaultDb, DbType } from '../../drizzle/db';
import {
  providerSubscriptions,
  ProviderSubscription,
} from '../../drizzle/schema';
// The SAME predicate `hasLiveBasePlan` reads. Re-homing `is_default` onto a row
// this call would not consider live is how the account ends up holding a
// default that still reads as unbilled — one definition of "live", not two.
// `hasLegacyProvider` is the detector for the dual-provider shape the
// incumbent guard below can produce: it answers true precisely when the
// default provider has a live row AND a DIFFERENT provider also has one.
import { hasLegacyProvider, isLive } from './provider-subscription.util';

const logger = new Logger('RehomeDefault');

/**
 * Hand `is_default` to a still-live row after the row that held it has died.
 *
 * PROVIDER-AGNOSTIC ON PURPOSE. This began as a private method on
 * `LemonSqueezyWebhookService`, and that is precisely how this branch's
 * recurring defect found its SEVENTH home: `endStripeProviderRows` clears the
 * flag off every Stripe row scoped to `provider = 'stripe'`, a live Lemon
 * Squeezy row survives untouched, and there was no Stripe-side re-home to hand
 * the flag on. We fixed the Lemon Squeezy direction in `f331109` and left its
 * exact mirror open. A second copy would only guarantee an eighth, so both
 * directions now call THIS.
 *
 * WHY IT EXISTS AT ALL. `is_default` names the provider currently billing an
 * account, and `provider_subscriptions_one_default_idx` is a partial UNIQUE
 * index allowing exactly ONE true row per subscription. Releasing the flag off
 * a dying row while something else on the account is still live leaves the
 * account with NO default: `pickDefaultProvider` returns null, `findItem`
 * returns null (it scopes to the default), `hasLiveBasePlan` answers false for
 * a customer who is demonstrably being charged, and `plan-change.service.ts`
 * routes their next change through its FREE->paid branch — a SECOND live
 * subscription on a card that is already being billed.
 *
 * ORDER IS LOAD-BEARING, IN BOTH DIRECTIONS.
 *
 *  1. The caller must have ALREADY written `is_default = false` onto the dying
 *     row. Claiming the flag here while the dead row still held it would raise
 *     23505 against the partial unique index mid-webhook. Release first, claim
 *     second; never both at once.
 *  2. The caller must have ALREADY marked the dying rows not-live (`expired`,
 *     `canceled`). The heir search filters on the real `isLive`, so a row that
 *     is about to die but has not been written yet would still look live and
 *     could win — the flag would land on a corpse. Running this AFTER the
 *     status write is what makes only a genuinely live row eligible.
 *
 * BASE PLAN FIRST, and only then a live add-on. `findItem` scopes every lookup
 * to the default provider, so parking the flag on an add-on row still lets
 * `findItem('BASE_PLAN')` resolve — but a base plan holding its own flag is
 * the shape the rest of the system expects, and the add-on fallback exists
 * only for the genuinely odd account whose base plan lapsed while an add-on
 * runs on.
 *
 * If nothing is live the flag stays released. That is the correct end state:
 * the free slot is what lets the customer subscribe again at either provider.
 *
 * TAKES ITS DB HANDLE. `StripeAdapter` is Nest-injected with `DRIZZLE` while
 * the utils and the Lemon Squeezy webhook service import the module-level
 * `db`; both resolve to the same drizzle instance at runtime, but their TESTS
 * fake different ones. Reaching for the module-level handle unconditionally
 * would make the adapter's spec issue real SQL against the developer's
 * database. Defaults to the module handle so the two util call sites read
 * unchanged.
 *
 * NEVER THROWS. Every caller runs after money has already moved — a completed
 * webhook delivery, a cancelled subscription, an operator reset. Failing the
 * request at that point would report that something did not happen when it
 * demonstrably did, and a webhook 500 buys a retry storm rather than a fix.
 * A missed re-home is self-healing (the next lifecycle event re-runs it) so it
 * is logged loudly instead.
 */
export async function rehomeDefault(input: {
  /** Our `subscriptions.id`. */
  subscriptionId: number;
  /**
   * `provider_subscriptions.id` of the row that just died, excluded from the
   * heir search. Omit when a whole PROVIDER died rather than a single row —
   * those rows are already excluded by `isLive` because the caller marked them
   * terminal first (see rule 2 above).
   */
  excludeRowId?: number;
  /** Defaults to the module-level handle; Nest-injected callers pass theirs. */
  db?: DbType;
}): Promise<void> {
  const db = input.db ?? defaultDb;
  try {
    const siblings = await db
      .select({
        id: providerSubscriptions.id,
        itemType: providerSubscriptions.itemType,
        providerStatus: providerSubscriptions.providerStatus,
        endsAt: providerSubscriptions.endsAt,
        provider: providerSubscriptions.provider,
        providerQuantity: providerSubscriptions.providerQuantity,
        isDefault: providerSubscriptions.isDefault,
      })
      .from(providerSubscriptions)
      .where(eq(providerSubscriptions.subscriptionId, input.subscriptionId));

    const rows = siblings as ProviderSubscription[];

    // Somebody already holds it and is genuinely live: nothing to do. Checked
    // BEFORE the heir search so this stays idempotent — a redelivered webhook
    // must not move a flag that is already correctly placed.
    if (rows.some((row) => row.isDefault && isLive(row))) {
      // This is also the ONLY place the dual-provider shape from the eighth
      // incarnation reaches: `writeStripeBasePlanRow` deliberately inserts
      // `isDefault: false` beside a live Lemon Squeezy default, and this guard
      // is what makes that insert a no-op instead of a re-home. Nothing else
      // observes it — no log, no metric — so an account paying TWO providers
      // at once stays silent until the customer complains.
      //
      // `hasLegacyProvider` is exactly the predicate: it reads the SAME
      // `pickDefaultProvider` this guard implicitly relies on, and answers
      // true only when the incumbent's own row is live (found above) and a
      // DIFFERENT provider also has a live row. Ordinary idempotent
      // redelivery — the incumbent is the only live provider — must stay
      // quiet, or a warn here trains people to ignore it. Only the genuinely
      // dual-billed shape gets a warn, naming the subscription and both
      // providers so an on-call human can act without querying the database
      // first.
      if (hasLegacyProvider(rows)) {
        const incumbent = rows.find((row) => row.isDefault && isLive(row));
        const other = rows.find(
          (row) => row.provider !== incumbent?.provider && isLive(row),
        );
        logger.warn(
          `Subscription ${input.subscriptionId} is being billed by TWO ` +
            `providers at once: ${incumbent?.provider} holds is_default ` +
            `while a live ${other?.provider} row also exists. Only ` +
            `${incumbent?.provider} is currently reachable for cancels and ` +
            `plan changes; the other provider will keep charging until it ` +
            `is manually resolved.`,
        );
      } else {
        logger.debug(
          `Subscription ${input.subscriptionId} already holds its default ` +
            `on a live row; nothing to re-home.`,
        );
      }
      return;
    }

    // `isLive` is deliberately NOT a status string comparison: Lemon Squeezy's
    // `cancelled` is still live until `ends_at`, and re-homing onto a
    // `cancelled` base plan mid-period is exactly right.
    const candidates = rows.filter(
      (row) => row.id !== input.excludeRowId && isLive(row),
    );
    if (candidates.length === 0) return;

    const heir =
      candidates.find((row) => row.itemType === 'BASE_PLAN') ?? candidates[0];

    // Already correct — an account can legitimately hold its default on a
    // second row if some other path re-homed it first. Writing again would be
    // harmless but the guard keeps the "exactly one" invariant explicit.
    if (heir.isDefault) return;

    await db
      .update(providerSubscriptions)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(providerSubscriptions.id, heir.id));

    logger.log(
      `Moved is_default to provider row ${heir.id} (${heir.provider} ` +
        `${heir.itemType}) on subscription ${input.subscriptionId}; the ` +
        `account is still being billed.`,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      `Failed to re-home is_default for subscription ` +
        `${input.subscriptionId}: ${message}. The account may now hold ZERO ` +
        `defaults while a provider still bills it, which reads as unbilled ` +
        `and can open a SECOND subscription.`,
    );
  }
}
