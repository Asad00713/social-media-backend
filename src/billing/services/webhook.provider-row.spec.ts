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
 * Every `where` in the handlers under test is an equality (or a conjunction of
 * them) scoped to the one account being touched. Rather than interpret
 * drizzle's SQL AST, the fake applies a single predicate, which these tests
 * leave wide open — there is exactly one account in the store.
 */
type Predicate = (row: Row) => boolean;
let wherePredicate: Predicate;

function rowsOf(name: string): Row[] {
  tables[name] = tables[name] ?? [];
  return tables[name];
}

function makeDb(): any {
  return {
    select: () => {
      let target = 'unknown';
      const chain: any = {
        from: (t: unknown) => {
          target = tableName(t);
          return chain;
        },
        innerJoin: () => chain,
        leftJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(rowsOf(target).filter(wherePredicate)).then(resolve),
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
      const apply = (): void => {
        for (const row of rowsOf(target)) {
          if (wherePredicate(row)) Object.assign(row, patch);
        }
      };
      const chain: any = {
        set: (v: Row) => {
          patch = v;
          return chain;
        },
        where: () => {
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
      const apply = (): void => {
        tables[target] = rowsOf(target).filter((r) => !wherePredicate(r));
      };
      const chain: any = {
        where: () => {
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
  wherePredicate = () => true;
}

function providerRow(): Row {
  return rowsOf('provider_subscriptions')[0];
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
