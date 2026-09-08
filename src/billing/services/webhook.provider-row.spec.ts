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

  const pairs: { column: string; value: unknown }[] = [];
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
      if (!opText.includes('=')) {
        throw new Error(`The db fake only understands '=', saw "${opText}".`);
      }
      // The bound value is a drizzle `Param`, not the raw literal.
      const param = chunks[i + 2] as any;
      const value =
        param && typeof param === 'object' && 'value' in param
          ? param.value
          : param;
      pairs.push({ column: camel(chunk.name), value });
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
            rowsOf(target).push({ id: rowsOf(target).length + 1, ...row });
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
      const apply = (): void => {
        for (const row of rowsOf(target)) {
          if (match(row)) Object.assign(row, patch);
        }
      };
      const chain: any = {
        set: (v: Row) => {
          patch = v;
          return chain;
        },
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

function makeService(): WebhookService {
  return new WebhookService({} as never, {} as never, lookup as never);
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
