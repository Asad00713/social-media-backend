/**
 * The Stripe webhook is a first-class WRITER of `provider_subscriptions`.
 *
 * It was not treated as one, and that is the fourth relocation of a single
 * defect on this branch. `provider_subscriptions` is read by every branch that
 * decides whether an account is being billed (`hasLiveBasePlan()`), and the
 * webhook is the path that actually ENDS subscriptions in production — a
 * customer cancels, the period runs out, and Stripe sends
 * `customer.subscription.deleted`. Round 2 wired the three creation sites and
 * left that one untouched: `grep -c "providerSubscriptions"` over
 * `webhook.service.ts` returned 0.
 *
 * What that cost:
 *
 *   1. `handleSubscriptionDeleted` nulled `stripe_subscription_id`, set FREE
 *      and deleted the subscription_items, leaving the BASE_PLAN provider row
 *      at `provider_status = 'active'`, `is_default = true`. The account read
 *      as FREE locally while holding a live-looking row naming a subscription
 *      Stripe had deleted. The customer's next re-subscribe read
 *      `hasLiveBasePlan()` = TRUE (a row exists, so the legacy fallback never
 *      fires), took the already-paying branch, handed Stripe the dead id and
 *      500'd with `resource_missing` — every time. They could never
 *      re-subscribe. `clearStaleStripeSubscription` cannot rescue it: it
 *      early-returns on the null column this handler just wrote.
 *
 *   2. The dead row also kept `is_default = true`, squatting on the one slot
 *      `provider_subscriptions_one_default_idx` allows, so a later Lemon
 *      Squeezy signup would raise 23505 AFTER LS had already charged.
 *
 *   3. `handleSubscriptionUpdated` wrote status/period to `subscriptions`
 *      only. A cancellation scheduled from the Stripe Dashboard arrives ONLY
 *      as that event, so the provider row went on saying `active` with no
 *      `ends_at` — the branch deciding whether to cancel at the provider was
 *      answering from data that had stopped tracking Stripe.
 *
 * THE FAKE
 *
 * The sibling specs' fake pops from a positional queue and is table-blind, so
 * a write is never visible to a later select and a write/read mismatch cannot
 * be caught at all. This file uses a real table-keyed store: `insert`/`update`
 * mutate rows and `select` reads them back, so every assertion below is on the
 * resulting STATE rather than on a function having been called.
 *
 * ts-jest is transpile-only here (`isolatedModules`), so a type-level
 * assertion would be VACUOUS at runtime. Every assertion is on a runtime value.
 */

/* The fakes stand in for drizzle's fluent builders, whose chain types are not
   expressible here — `any` is deliberate and confined to the fakes. */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import { Logger } from '@nestjs/common';

interface Row {
  [column: string]: unknown;
}

/** table name -> rows. The whole database, for one test. */
let tables: Record<string, Row[]>;

/**
 * Which table a drizzle table object refers to.
 *
 * Drizzle hangs the SQL name off a symbol; reading it is what makes this fake
 * table-AWARE, and being table-aware is the entire point — a fake that ignores
 * `from()` cannot tell a write to `subscriptions` from a write to
 * `provider_subscriptions`, which is precisely the mismatch under test.
 */
function tableName(t: unknown): string {
  const sym = Object.getOwnPropertySymbols(t as object).find((s) =>
    String(s).includes('Name'),
  );
  const name = sym ? (t as any)[sym] : undefined;
  return typeof name === 'string' ? name : 'unknown';
}

/**
 * THIS FAKE USED TO IGNORE `where()`.
 *
 * It applied one wide-open `wherePredicate`, so every `update` and `delete`
 * patched EVERY row in the table. That was survivable only for as long as each
 * test seeded exactly one account and one provider row — and the C1 fix breaks
 * that assumption on purpose: `endStripeProviderRows` is scoped to
 * `provider = 'stripe'`, and the whole point of the seventh incarnation is
 * what happens to the live LEMON SQUEEZY row sitting beside it. Under the old
 * fake a test seeding both would have watched the Stripe-scoped UPDATE flatten
 * the Lemon Squeezy row too, and would have "passed" while proving the exact
 * opposite of the invariant it claims to check.
 *
 * So it now interprets the real clause, ported verbatim from
 * `lemonsqueezy-webhook.service.spec.ts` (which needed it first, for the same
 * reason).
 */
/**
 * A REAL predicate, built by walking drizzle's `queryChunks`.
 *
 * A wide-open predicate would be worse than useless here. Every routing
 * decision in the service is a `where` — "which provider row does this
 * provider_subscription_id name", "does this account already hold a default",
 * "which subscription_items row belongs to this add-on" — so a fake that
 * ignores `where` makes the routing tests assert nothing: the first row in the
 * table answers every query and an add-on event appears to update the base
 * plan correctly. That is exactly the class of silent agreement between test
 * and code this branch keeps producing.
 *
 * `eq(column, value)` serialises to chunks `['', {name}, ' = ', value, '']`, and
 * `and(...)` NESTS those inside its own chunks, so the walk is recursive.
 * Flattening yields the column/value pairs, which is all the service ever
 * builds. An unrecognised shape throws rather than falling back to "match
 * everything" — a fake that silently widens is how a mutation check ends up
 * testing nothing.
 */
type Predicate = (row: Row) => boolean;

/** A drizzle column chunk, as opposed to a literal or an operator. */
function isColumn(chunk: unknown): boolean {
  return (
    !!chunk &&
    typeof chunk === 'object' &&
    typeof (chunk as any).name === 'string'
  );
}

/** camelCase property for a snake_case SQL column. */
function camel(sqlName: string): string {
  return sqlName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Depth-first flatten of drizzle's nested `queryChunks`. */
function flatten(chunks: unknown[], out: unknown[] = []): unknown[] {
  for (const chunk of chunks) {
    const nested = (chunk as any)?.queryChunks as unknown[] | undefined;
    if (Array.isArray(nested)) flatten(nested, out);
    else out.push(chunk);
  }
  return out;
}

function predicateFrom(condition: unknown): Predicate {
  if (!condition) return () => true;
  const top = (condition as any).queryChunks as unknown[] | undefined;
  if (!Array.isArray(top)) {
    throw new Error('The db fake only understands drizzle eq()/and() clauses.');
  }
  const chunks = flatten(top);

  const pairs: { column: string; value: unknown; isGt?: boolean }[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk: any = chunks[i];
    if (isColumn(chunk)) {
      // ['', {name}, ' = ', value, ...]
      const op = chunks[i + 1] as any;
      const opText = Array.isArray(op?.value) ? String(op.value[0]) : '';
      // `inArray(col, <subquery>)` — the account-wide usage fan-out uses one.
      // Interpreting a nested SELECT here would be a second query engine, and
      // the tests that exercise it seed one owner, so the column is left
      // unconstrained. Stated as an explicit BRANCH rather than a fallback:
      // the `throw` below still fires for any other operator, so an
      // unrecognised clause can never silently widen to "match everything",
      // which is what the old table-wide predicate did for every query.
      if (opText.includes(' in ')) {
        while (i + 1 < chunks.length && !isColumn(chunks[i + 1])) i++;
        continue;
      }
      // '>' is drizzle's gt(): the failed-payments window reads it.
      const isGt = !opText.includes('=') && opText.includes('>');
      if (!opText.includes('=') && !isGt) {
        throw new Error(
          `The db fake only understands '=' and '>', saw "${opText}".`,
        );
      }
      // The bound value is a drizzle `Param`, not the raw literal.
      const param = chunks[i + 2] as any;
      const value =
        param && typeof param === 'object' && 'value' in param
          ? param.value
          : param;
      pairs.push({ column: camel(chunk.name), value, isGt });
      i += 2;
    }
  }

  // Zero pairs is legitimate only for a clause that was ENTIRELY a subquery
  // `in` (the usage fan-out). Anything else reaching here means the walk
  // understood nothing, and matching everything would be the silent widening
  // this interpreter exists to prevent.
  if (pairs.length === 0) return () => true;

  return (row: Row) =>
    pairs.every((p) => {
      const actual = row[p.column];
      if (p.isGt) {
        return (
          actual instanceof Date &&
          p.value instanceof Date &&
          actual.getTime() > p.value.getTime()
        );
      }
      // Dates compare by value; ids arrive as numbers or strings.
      if (actual instanceof Date && p.value instanceof Date) {
        return actual.getTime() === p.value.getTime();
      }
      return actual === p.value;
    });
}

function rowsOf(name: string): Row[] {
  tables[name] = tables[name] ?? [];
  return tables[name];
}

function makeDb(): any {
  return {
    select: () => {
      let target = 'unknown';
      let match: Predicate = () => true;
      const chain: any = {
        from: (t: unknown) => {
          target = tableName(t);
          return chain;
        },
        innerJoin: () => chain,
        leftJoin: () => chain,
        where: (c: unknown) => {
          match = predicateFrom(c);
          return chain;
        },
        orderBy: () => chain,
        limit: () => chain,
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(rowsOf(target).filter(match)).then(resolve),
      };
      return chain;
    },

    insert: (t: unknown) => {
      const target = tableName(t);
      const chain: any = {
        values: (v: Row | Row[]) => {
          const incoming = Array.isArray(v) ? v : [v];
          for (const row of incoming) {
            rowsOf(target).push({
              id: rowsOf(target).length + 1,
              // A column default the real table fills in.
              ...(target === 'failed_payments'
                ? {
                    createdAt: new Date(),
                    resolved: false,
                    featuresRestricted: false,
                  }
                : {}),
              ...row,
            });
          }
          return chain;
        },
        onConflictDoUpdate: () => chain,
        onConflictDoNothing: () => chain,
        returning: () => Promise.resolve(rowsOf(target).slice(-1)),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(rowsOf(target).slice(-1)).then(resolve),
      };
      return chain;
    },

    update: (t: unknown) => {
      const target = tableName(t);
      let patch: Row = {};
      let match: Predicate = () => true;
      /** The rows the WHERE matched, as one atomic step like Postgres's. */
      let updated: Row[] = [];
      const apply = (): Row[] => {
        const hit = rowsOf(target).filter((row) => match(row));
        for (const row of hit) Object.assign(row, patch);
        return hit;
      };
      const chain: any = {
        set: (v: Row) => {
          patch = v;
          return chain;
        },
        where: (c: unknown) => {
          match = predicateFrom(c);
          updated = apply();
          return chain;
        },
        returning: () => Promise.resolve(updated.map((row) => ({ ...row }))),
        then: (resolve: (v: unknown) => unknown) => {
          apply();
          return Promise.resolve([]).then(resolve);
        },
      };
      return chain;
    },

    delete: (t: unknown) => {
      const target = tableName(t);
      let match: Predicate = () => true;
      const apply = (): void => {
        tables[target] = rowsOf(target).filter((r) => !match(r));
      };
      const chain: any = {
        where: (c: unknown) => {
          match = predicateFrom(c);
          apply();
          return chain;
        },
        then: (resolve: (v: unknown) => unknown) => {
          apply();
          return Promise.resolve([]).then(resolve);
        },
      };
      return chain;
    },
  };
}

const mockDb = makeDb();
jest.mock('../../drizzle/db', () => ({ db: mockDb }));

jest.mock('./invoice-sync.util', () => ({
  upsertInvoiceFromStripe: jest.fn().mockResolvedValue(undefined),
  getInvoiceSubscriptionId: () => null,
}));

import { WebhookService } from './webhook.service';
// The REAL predicate the production readers use. A local re-implementation
// here could agree with a broken one in `src/`.
import { isLive } from './provider-subscription.util';

const SUBSCRIPTION_ID = 42;

/** A paying Stripe account, with the provider row 0034 backfills for one. */
function seedPayingAccount(): void {
  tables = {
    subscriptions: [
      {
        id: SUBSCRIPTION_ID,
        userId: 'user-1',
        planCode: 'PRO',
        status: 'active',
        stripeCustomerId: 'cus_live',
        stripeSubscriptionId: 'sub_live',
        cancelAtPeriodEnd: false,
        currentPeriodEnd: new Date('2026-10-01'),
        scheduledPlanCode: null,
        scheduledChangeAt: null,
      },
    ],
    provider_subscriptions: [
      {
        id: 1,
        subscriptionId: SUBSCRIPTION_ID,
        provider: 'stripe',
        itemType: 'BASE_PLAN',
        providerSubscriptionId: 'sub_live',
        providerStatus: 'active',
        endsAt: null,
        renewsAt: new Date('2026-10-01'),
        isDefault: true,
      },
    ],
    billing_events: [],
    subscription_items: [],
    workspace_usage: [],
    workspace: [],
    plans: [],
  };
}

function providerRow(): Row {
  return rowsOf('provider_subscriptions')[0];
}

/**
 * The invariant this whole branch keeps breaking, in its seventh incarnation.
 *
 *   anything live => EXACTLY ONE `is_default` row, and that row is itself live
 *   nothing live  => ZERO
 *
 * Mirrored from `expectDefaultInvariant()` in
 * `lemonsqueezy-webhook.service.spec.ts` deliberately — one statement of the
 * rule, asserted on both providers' termination paths, because the defect's
 * habit is to be fixed on one side and left open on the other.
 *
 * Asserting the FIELD alone is what let the seventh ship: a test that checks
 * `isDefault === false` on the dying Stripe row passes just as happily when
 * the account is left with zero defaults while Lemon Squeezy bills it.
 */
function expectDefaultInvariant(): void {
  const rows = rowsOf('provider_subscriptions');
  const defaults = rows.filter((r) => r.isDefault === true);

  // Never two: `provider_subscriptions_one_default_idx` would reject it.
  expect(defaults.length).toBeLessThanOrEqual(1);

  const live = rows.filter((r) => isLive(r as never));
  if (live.length > 0) {
    // Something is still being billed, so the account must still name a
    // provider — otherwise `hasLiveBasePlan` answers false for a paying
    // customer and `plan-change.service.ts` opens a SECOND subscription.
    expect(defaults).toHaveLength(1);
    // And the flag must sit on a row that is genuinely live. Parking it on a
    // corpse satisfies "exactly one" while still reading as unbilled, because
    // `findItem` scopes to the default and `isLive` then rejects it.
    expect(isLive(defaults[0] as never)).toBe(true);
  } else {
    // Nothing live: the slot must be FREE so the customer can subscribe again
    // at either provider. A dead row squatting on it raises 23505 after the
    // next provider has already charged.
    expect(defaults).toHaveLength(0);
  }
}

/**
 * The seed whose ABSENCE let the seventh incarnation ship: a live Lemon
 * Squeezy row beside the Stripe one that is about to die. Every existing test
 * in this file seeds Stripe alone, so `endStripeProviderRows` clearing the
 * flag left nothing live and the invariant's zero-defaults branch passed.
 *
 * This is the real cutover shape — an abandoned or reversed migration, or
 * `POST /billing/reset` on an account holding both providers.
 */
function seedLiveLemonSqueezyBeside(): void {
  rowsOf('provider_subscriptions').push({
    id: 2,
    subscriptionId: SUBSCRIPTION_ID,
    provider: 'lemonsqueezy',
    itemType: 'BASE_PLAN',
    providerSubscriptionId: 'ls_sub_1',
    providerStatus: 'active',
    providerQuantity: 1,
    endsAt: null,
    renewsAt: new Date('2026-11-07'),
    isDefault: false,
  });
}

/** The account-wide fan-out and add-on bookkeeping are not under test here. */
const lookup = {
  getOwnerId: jest.fn().mockResolvedValue('user-1'),
  getAddonQuantities: jest.fn().mockResolvedValue({
    extraChannels: 0,
    extraMembers: 0,
    extraWorkspaces: 0,
    extraAiTokens: 0,
  }),
  applyLimitsToAllWorkspaces: jest.fn().mockResolvedValue(undefined),
};

/** The email service has its own spec; here only what the webhook hands it. */
const billingEmail = {
  paymentFailed: jest.fn().mockResolvedValue(undefined),
  trialEnding: jest.fn().mockResolvedValue(undefined),
  planChanged: jest.fn().mockResolvedValue(undefined),
  planName: jest.fn((code: string) =>
    Promise.resolve(code === 'PRO' ? 'Pro' : code),
  ),
};

function makeService(): WebhookService {
  return new WebhookService(
    {} as never,
    {} as never,
    lookup as never,
    billingEmail as never,
  );
}

/** The same, for the handlers that also take Stripe's `previous_attributes`. */
function call2(
  service: WebhookService,
  handler: string,
  payload: unknown,
  previous: unknown,
): Promise<void> {
  return (service as any)[handler](payload, previous) as Promise<void>;
}

/** Reach the private handler under test without going through the dispatcher. */
function call(
  service: WebhookService,
  handler: string,
  payload: unknown,
): Promise<void> {
  return (service as any)[handler](payload) as Promise<void>;
}

beforeEach(() => {
  seedPayingAccount();
  jest.clearAllMocks();
});

describe('customer.subscription.deleted', () => {
  const DELETED_EVENT = {
    id: 'sub_live',
    status: 'canceled',
    items: { data: [{ id: 'si_1', current_period_end: 1790000000 }] },
  };

  it('leaves no live provider row, so the customer can re-subscribe', async () => {
    await call(makeService(), 'handleSubscriptionDeleted', DELETED_EVENT);

    // The resulting STATE, not the call. A row still reading `active` is what
    // made `hasLiveBasePlan()` answer TRUE for an account Stripe had already
    // deleted, sending the next re-subscribe into the already-paying branch
    // with a dead id and an uncaught `resource_missing` 500.
    expect(providerRow().providerStatus).toBe('canceled');
  });

  it('releases the is_default slot a Lemon Squeezy signup needs', async () => {
    await call(makeService(), 'handleSubscriptionDeleted', DELETED_EVENT);

    // `provider_subscriptions_one_default_idx` permits ONE true row per
    // subscription. A dead Stripe row holding it makes the later LS insert
    // raise 23505 — after Lemon Squeezy has already charged the customer.
    expect(providerRow().isDefault).toBe(false);
  });

  it('still resets the account to FREE', async () => {
    await call(makeService(), 'handleSubscriptionDeleted', DELETED_EVENT);

    // The pre-existing behaviour must survive the new write.
    const sub = rowsOf('subscriptions')[0];
    expect(sub.planCode).toBe('FREE');
    expect(sub.stripeSubscriptionId).toBeNull();
  });

  it('leaves the slot free when nothing else on the account is live', async () => {
    await call(makeService(), 'handleSubscriptionDeleted', DELETED_EVENT);

    // Stripe alone, and it just died: zero defaults is the CORRECT end state,
    // and the free slot is what lets the customer subscribe again anywhere.
    expectDefaultInvariant();
  });

  it('hands is_default to a live LEMON SQUEEZY row instead of stranding it', async () => {
    // THE SEVENTH INCARNATION, and the exact mirror of the sixth that
    // `f331109` fixed on the Lemon Squeezy side.
    //
    // `endStripeProviderRows` sets `is_default = false` scoped to
    // `provider = 'stripe'`, so this live Lemon Squeezy row survives it
    // completely untouched — the account IS still being billed — and nothing
    // re-homed the flag. `rehomeDefault` existed ONLY on the Lemon Squeezy
    // webhook service; there was no Stripe-side equivalent at all.
    //
    // The resulting state was zero defaults while Lemon Squeezy actively
    // charges: `pickDefaultProvider` null, `findItem` null (it scopes to the
    // default), `hasLiveBasePlan` FALSE for a paying customer, so
    // `plan-change.service.ts:342` reads `isAlreadyPaying = false` and `:397`
    // takes the FREE->paid branch — a SECOND live subscription, double
    // billing. The legacy fallback cannot rescue it either, because
    // `hasAnyStripeRow` is true.
    seedLiveLemonSqueezyBeside();

    await call(makeService(), 'handleSubscriptionDeleted', DELETED_EVENT);

    const ls = rowsOf('provider_subscriptions').find(
      (r) => r.provider === 'lemonsqueezy',
    ) as Row;
    // The live row inherits...
    expect(ls.isDefault).toBe(true);
    // ...and the dead Stripe row does not squat on the slot.
    expect(providerRow().isDefault).toBe(false);
    // The assertion that actually matters: not the field, the INVARIANT.
    expectDefaultInvariant();
  });

  it('never adds a SECOND default when a live add-on already holds the flag', async () => {
    // The idempotence guard in `rehomeDefault`, and it is NOT redundant with
    // the `heir.isDefault` check further down.
    //
    // Here a live Lemon Squeezy ADD-ON holds the flag while a live Lemon
    // Squeezy BASE_PLAN does not — legitimate, per `rehomeDefault`'s own
    // base-plan-first note about an account whose base plan lapsed while an
    // add-on ran on. The heir search prefers BASE_PLAN, so the heir is NOT the
    // row currently holding the flag: `heir.isDefault` is false, the write
    // goes ahead, and the account momentarily holds TWO defaults — 23505
    // against `provider_subscriptions_one_default_idx`, inside a webhook, so
    // Stripe retries forever against a state that cannot converge.
    //
    // The account already names a live provider, so there is nothing to
    // re-home and the correct action is to do nothing at all.
    seedLiveLemonSqueezyBeside();
    rowsOf('provider_subscriptions').push({
      id: 3,
      subscriptionId: SUBSCRIPTION_ID,
      provider: 'lemonsqueezy',
      itemType: 'EXTRA_CHANNEL',
      providerSubscriptionId: 'ls_sub_addon',
      providerStatus: 'active',
      providerQuantity: 1,
      endsAt: null,
      renewsAt: new Date('2026-11-07'),
      isDefault: true,
    });
    // The Stripe row is not the one holding the flag here.
    providerRow().isDefault = false;

    await call(makeService(), 'handleSubscriptionDeleted', DELETED_EVENT);

    // Untouched: the add-on still holds it, and the base plan did not take it.
    const addon = rowsOf('provider_subscriptions').find(
      (r) => r.itemType === 'EXTRA_CHANNEL',
    ) as Row;
    expect(addon.isDefault).toBe(true);
    expectDefaultInvariant();
  });

  it('does not re-home onto a Lemon Squeezy row that is itself dead', async () => {
    // Pins the `isLive` filter inside the heir search. A cross-provider row
    // EXISTING is not the same fact as the account still being billed — an
    // expired Lemon Squeezy row taking the flag would satisfy "exactly one
    // default" while `findItem` + `isLive` still read the account as unbilled,
    // which is the corpse-holds-the-flag half of the invariant.
    seedLiveLemonSqueezyBeside();
    (
      rowsOf('provider_subscriptions').find(
        (r) => r.provider === 'lemonsqueezy',
      ) as Row
    ).providerStatus = 'expired';

    await call(makeService(), 'handleSubscriptionDeleted', DELETED_EVENT);

    const ls = rowsOf('provider_subscriptions').find(
      (r) => r.provider === 'lemonsqueezy',
    ) as Row;
    expect(ls.isDefault).toBe(false);
    expectDefaultInvariant();
  });
});

describe('customer.subscription.updated', () => {
  it('carries a dashboard-scheduled cancellation onto the provider row', async () => {
    const periodEnd = 1790000000;
    await call(makeService(), 'handleSubscriptionUpdated', {
      id: 'sub_live',
      status: 'active',
      cancel_at_period_end: true,
      items: { data: [{ id: 'si_1', current_period_end: periodEnd }] },
    });

    // A cancellation scheduled in the Stripe Dashboard reaches us ONLY as this
    // event. `isLive()` reads `endsAt`; without this the row went on claiming
    // an open-ended renewal for a subscription with a known end date.
    const row = providerRow();
    expect(row.endsAt).toEqual(new Date(periodEnd * 1000));
    expect(row.renewsAt).toBeNull();
  });

  it('carries a dunning failure onto the provider row', async () => {
    await call(makeService(), 'handleSubscriptionUpdated', {
      id: 'sub_live',
      status: 'past_due',
      cancel_at_period_end: false,
      items: { data: [{ id: 'si_1', current_period_end: 1790000000 }] },
    });

    // Both tables hold this fact and only one was being written, so they
    // drifted apart the moment Stripe changed anything on its own.
    expect(rowsOf('subscriptions')[0].status).toBe('past_due');
    expect(providerRow().providerStatus).toBe('past_due');
  });

  it('does not invent a row for a subscription it has never seen', async () => {
    // `customer.subscription.updated` can arrive before
    // `checkout.session.completed` — Stripe does not guarantee event ordering.
    // An upsert here would claim `is_default` for an account whose provider is
    // not yet decided, and during the Lemon Squeezy overlap that flag IS the
    // cutover mechanism.
    tables.provider_subscriptions = [];

    await call(makeService(), 'handleSubscriptionUpdated', {
      id: 'sub_live',
      status: 'active',
      cancel_at_period_end: false,
      items: { data: [{ id: 'si_1', current_period_end: 1790000000 }] },
    });

    expect(rowsOf('provider_subscriptions')).toHaveLength(0);
  });
});

// ------------------------------------------------------------ billing emails

describe('billing emails', () => {
  // The "skipped: boom" warnings are the behaviour under test, not output.
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  // The bank's reason is deliberately in the payload: the email must ignore
  // it (it is a PaymentIntent field, not an Invoice one).
  const FAILED_INVOICE = {
    id: 'in_1',
    amount_due: 2900,
    currency: 'usd',
    attempt_count: 2,
    next_payment_attempt: 1790000000,
    last_payment_error: { message: 'Your card has insufficient funds.' },
  };

  function seedInvoice(): void {
    rowsOf('invoices').push({
      id: 7,
      stripeInvoiceId: 'in_1',
      subscriptionId: SUBSCRIPTION_ID,
    });
    rowsOf('payment_methods').push({
      id: 1,
      stripeCustomerId: 'cus_live',
      cardBrand: 'visa',
      cardLast4: '4242',
      isDefault: true,
      createdAt: new Date('2026-09-01'),
    });
  }

  it('a failed payment emails the payer with the invoice, card and next try', async () => {
    seedInvoice();

    await call(makeService(), 'handleInvoicePaymentFailed', FAILED_INVOICE);

    expect(billingEmail.paymentFailed).toHaveBeenCalledTimes(1);
    expect(billingEmail.paymentFailed.mock.calls[0][0]).toEqual({
      userId: 'user-1',
      planName: 'Pro',
      amountCents: 2900,
      currency: 'usd',
      cardLast4: '4242',
      cardBrand: 'visa',
      reason: null,
      nextAttempt: new Date(1790000000 * 1000),
      dedupeKey: 'payment-failed.in_1.2',
    });
  });

  it('the same failure delivered twice carries one key; the next attempt a new one', async () => {
    seedInvoice();
    const service = makeService();

    await call(service, 'handleInvoicePaymentFailed', FAILED_INVOICE);
    await call(service, 'handleInvoicePaymentFailed', FAILED_INVOICE);
    await call(service, 'handleInvoicePaymentFailed', {
      ...FAILED_INVOICE,
      attempt_count: 3,
    });

    const keys = billingEmail.paymentFailed.mock.calls.map(
      (c) => (c[0] as { dedupeKey: string }).dedupeKey,
    );
    expect(keys).toEqual([
      'payment-failed.in_1.2',
      'payment-failed.in_1.2',
      'payment-failed.in_1.3',
    ]);
  });

  const fail = (service: WebhookService, attempt: number) =>
    call(service, 'handleInvoicePaymentFailed', {
      ...FAILED_INVOICE,
      attempt_count: attempt,
    });

  it('the third unresolved failure restricts the account and emails payment_restricted', async () => {
    seedInvoice();
    const service = makeService();

    await fail(service, 1);
    await fail(service, 2);
    expect(billingEmail.planChanged).not.toHaveBeenCalled();

    await fail(service, 3);

    expect(billingEmail.planChanged).toHaveBeenCalledTimes(1);
    expect(billingEmail.planChanged.mock.calls[0][0]).toMatchObject({
      userId: 'user-1',
      kind: 'payment_restricted',
      fromPlan: 'Pro',
      toPlan: 'Free',
    });
  });

  it('the 4th and 5th failures of the same episode send no second "moved to Free"', async () => {
    seedInvoice();
    const service = makeService();

    for (const attempt of [1, 2, 3, 4, 5]) await fail(service, attempt);

    expect(billingEmail.planChanged).toHaveBeenCalledTimes(1);
    // Each failure still gets its own "payment didn't go through" email.
    expect(billingEmail.paymentFailed).toHaveBeenCalledTimes(5);
    // The limits are still re-applied on every failure past the third.
    expect(lookup.applyLimitsToAllWorkspaces).toHaveBeenCalledTimes(3);
  });

  it('a new episode, after the old failures were resolved, restricts and emails again', async () => {
    seedInvoice();
    const service = makeService();
    for (const attempt of [1, 2, 3]) await fail(service, attempt);
    expect(billingEmail.planChanged).toHaveBeenCalledTimes(1);

    // A payment succeeded: `handleInvoicePaymentSucceeded` resolves them.
    for (const row of rowsOf('failed_payments')) row.resolved = true;
    for (const attempt of [1, 2, 3]) await fail(service, attempt);

    expect(billingEmail.planChanged).toHaveBeenCalledTimes(2);
  });

  it('a flagged failure older than 30 days does not block a new episode', async () => {
    seedInvoice();
    const service = makeService();
    // Unpaid and flagged, from an episode outside the 30-day window.
    rowsOf('failed_payments').push({
      id: 1,
      subscriptionId: SUBSCRIPTION_ID,
      resolved: false,
      featuresRestricted: true,
      createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    });

    for (const attempt of [1, 2, 3]) await fail(service, attempt);

    expect(billingEmail.planChanged).toHaveBeenCalledTimes(1);
  });

  it('two failure webhooks arriving together send one "moved to Free"', async () => {
    seedInvoice();
    const service = makeService();
    await fail(service, 1);
    await fail(service, 2);

    // The 3rd and 4th failures race: each reads the episode as unrestricted.
    await Promise.all([fail(service, 3), fail(service, 4)]);

    expect(billingEmail.planChanged).toHaveBeenCalledTimes(1);
    // The restriction itself is still applied by both.
    expect(lookup.applyLimitsToAllWorkspaces).toHaveBeenCalledTimes(2);
    expect(
      rowsOf('failed_payments').every((r) => r.featuresRestricted === true),
    ).toBe(true);
  });

  it('applyPaymentFailureRestrictions emails payment_restricted with a period-stable key', async () => {
    const service = makeService();
    const failure = (id: number): Row => ({
      id,
      subscriptionId: SUBSCRIPTION_ID,
      resolved: false,
      featuresRestricted: false,
      createdAt: new Date(),
    });

    rowsOf('failed_payments').push(failure(1));
    await (service as any).applyPaymentFailureRestrictions(
      SUBSCRIPTION_ID,
      'user-1',
    );
    // A second episode in the same billing period.
    rowsOf('failed_payments')[0].resolved = true;
    rowsOf('failed_payments').push(failure(2));
    await (service as any).applyPaymentFailureRestrictions(
      SUBSCRIPTION_ID,
      'user-1',
    );

    const key = `plan-changed.user-1.payment_restricted.sub_live.${new Date('2026-10-01').getTime()}`;
    const keys = billingEmail.planChanged.mock.calls.map(
      (c) => (c[0] as { dedupeKey: string }).dedupeKey,
    );
    expect(keys).toEqual([key, key]);
  });

  it('a mail failure never fails the webhook or loses the failure record', async () => {
    seedInvoice();
    billingEmail.paymentFailed.mockRejectedValueOnce(new Error('boom'));

    await expect(
      call(makeService(), 'handleInvoicePaymentFailed', FAILED_INVOICE),
    ).resolves.toBeUndefined();

    expect(rowsOf('failed_payments')).toHaveLength(1);
    expect(rowsOf('subscriptions')[0].status).toBe('past_due');
  });

  describe('trial_will_end', () => {
    const inDays = (days: number) =>
      Math.floor(Date.now() / 1000) + days * 24 * 60 * 60;
    const trial = (over: Record<string, unknown> = {}) => ({
      id: 'sub_live',
      status: 'trialing',
      cancel_at_period_end: false,
      trial_end: inDays(3),
      default_payment_method: null,
      ...over,
    });

    it('a normal trial is handed to the email service, with the card state', async () => {
      const event = trial();
      await call(makeService(), 'handleTrialWillEnd', event);
      await call(
        makeService(),
        'handleTrialWillEnd',
        trial({ default_payment_method: 'pm_1', trial_end: event.trial_end }),
      );

      const base = {
        userId: 'user-1',
        subscriptionId: SUBSCRIPTION_ID,
        trialEnd: new Date(event.trial_end * 1000),
        planCode: 'PRO',
      };
      expect(billingEmail.trialEnding.mock.calls.map((c) => c[0])).toEqual([
        { ...base, hasCard: false },
        { ...base, hasCard: true },
      ]);
    });

    it('sends nothing for a trial that was ended early', async () => {
      // Ending a trial now moves the end to now (or the past) and the status
      // off `trialing`: nobody should be told to "choose a plan".
      await call(
        makeService(),
        'handleTrialWillEnd',
        trial({ status: 'active', trial_end: inDays(-1) }),
      );
      await call(
        makeService(),
        'handleTrialWillEnd',
        trial({ trial_end: inDays(-1) }),
      );
      await call(
        makeService(),
        'handleTrialWillEnd',
        trial({ status: 'active' }),
      );

      expect(billingEmail.trialEnding).not.toHaveBeenCalled();
    });

    it('sends nothing for a trial that is set to cancel', async () => {
      await call(
        makeService(),
        'handleTrialWillEnd',
        trial({ cancel_at_period_end: true }),
      );

      expect(billingEmail.trialEnding).not.toHaveBeenCalled();
    });
  });

  describe('cancellation', () => {
    const update = (cancel: boolean) => ({
      id: 'sub_live',
      status: 'active',
      cancel_at_period_end: cancel,
      items: { data: [{ id: 'si_1', current_period_end: 1790000000 }] },
    });
    const previously = (cancel: boolean | undefined) =>
      cancel === undefined ? undefined : { cancel_at_period_end: cancel };

    function sent(): Array<{ kind: string; dedupeKey: string }> {
      return billingEmail.planChanged.mock.calls.map(
        (c) => c[0] as { kind: string; dedupeKey: string },
      );
    }

    it('Stripe saying false -> true emails cancel_scheduled', async () => {
      await call2(
        makeService(),
        'handleSubscriptionUpdated',
        update(true),
        previously(false),
      );

      expect(sent()).toHaveLength(1);
      expect(billingEmail.planChanged.mock.calls[0][0]).toMatchObject({
        userId: 'user-1',
        kind: 'cancel_scheduled',
        fromPlan: 'Pro',
        toPlan: 'Free',
        endsOn: new Date(1790000000 * 1000),
      });
    });

    it('an in-app cancel still emails: our row was written before the webhook arrived', async () => {
      // `downgradeToFree` and `cancelSubscription` store cancelAtPeriodEnd
      // themselves, so by the time Stripe's event lands our row says true.
      rowsOf('subscriptions')[0].cancelAtPeriodEnd = true;

      await call2(
        makeService(),
        'handleSubscriptionUpdated',
        update(true),
        previously(false),
      );

      expect(sent().map((s) => s.kind)).toEqual(['cancel_scheduled']);
    });

    it('the same event delivered again carries the same key', async () => {
      const service = makeService();
      for (let i = 0; i < 2; i++) {
        await call2(
          service,
          'handleSubscriptionUpdated',
          update(true),
          previously(false),
        );
      }

      const [first, second] = sent();
      expect(second.dedupeKey).toBe(first.dedupeKey);
    });

    it('an update that did not change the flag sends nothing', async () => {
      const service = makeService();
      await call2(
        service,
        'handleSubscriptionUpdated',
        update(true),
        previously(undefined),
      );
      await call2(service, 'handleSubscriptionUpdated', update(true), {
        status: 'trialing',
      });
      await call2(
        service,
        'handleSubscriptionUpdated',
        update(false),
        previously(true),
      );

      expect(sent()).toHaveLength(0);
    });

    it('applying a scheduled downgrade at renewal sends no second email', async () => {
      Object.assign(rowsOf('subscriptions')[0], {
        scheduledPlanCode: 'BASIC',
        scheduledChangeAt: new Date(1789000000 * 1000),
      });
      rowsOf('plans').push({ id: 1, code: 'BASIC', name: 'Basic' });

      await call2(
        makeService(),
        'handleSubscriptionUpdated',
        {
          id: 'sub_live',
          status: 'active',
          cancel_at_period_end: false,
          items: {
            data: [
              {
                id: 'si_1',
                current_period_start: 1790000000,
                current_period_end: 1792600000,
              },
            ],
          },
        },
        { current_period_start: 1787400000 },
      );

      expect(rowsOf('subscriptions')[0].planCode).toBe('BASIC');
      expect(billingEmail.planChanged).not.toHaveBeenCalled();
    });
  });

  it('subscription.deleted emails ended with the plan that ended', async () => {
    await call(makeService(), 'handleSubscriptionDeleted', {
      id: 'sub_live',
      status: 'canceled',
      items: { data: [{ id: 'si_1', current_period_end: 1790000000 }] },
    });

    expect(rowsOf('subscriptions')[0].planCode).toBe('FREE');
    expect(billingEmail.planChanged).toHaveBeenCalledTimes(1);
    expect(billingEmail.planChanged.mock.calls[0][0]).toMatchObject({
      userId: 'user-1',
      kind: 'ended',
      fromPlan: 'Pro',
      toPlan: 'Free',
    });
  });
});
