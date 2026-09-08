/**
 * `POST /billing/reset` must end the provider rows, not just the column.
 *
 * The fifth site of the same defect, and the one the transition inventory
 * caught rather than the review. `resetBillingState` is a live controller
 * endpoint (`billing.controller.ts:67`) whose whole purpose is to unblock a
 * customer whose `stripe_subscription_id` points at a subscription Stripe no
 * longer has — test data wiped, account swapped, test/live mode switched — so
 * they can re-subscribe.
 *
 * It nulls `stripe_subscription_id` exactly the way
 * `handleSubscriptionDeleted` does, and had exactly the same hole: the reset
 * account kept its BASE_PLAN provider row at `provider_status = 'active'`,
 * `is_default = true`. `hasLiveBasePlan()` reads that table, so it still
 * answered TRUE, and the very re-subscribe this endpoint exists to enable took
 * the already-paying branch, handed Stripe the dead id, and 500'd with
 * `resource_missing`. The endpoint appeared to succeed and fixed nothing.
 *
 * `clearStaleStripeSubscription` cannot repair it afterwards either: it
 * early-returns at `stripe-stale-subscription.util.ts:37` on the null column
 * this endpoint just wrote.
 *
 * The fake here is table-keyed and writes are visible to later reads, so the
 * assertions are on resulting STATE rather than on a function having been
 * called. ts-jest is transpile-only (`isolatedModules`), so every assertion
 * below is on a runtime value.
 */

/* The fakes stand in for drizzle's fluent builders; `any` is confined to them. */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

interface Row {
  [column: string]: unknown;
}

let tables: Record<string, Row[]>;

/** Drizzle hangs the SQL name off a symbol; reading it makes the fake table-aware. */
function tableName(t: unknown): string {
  const sym = Object.getOwnPropertySymbols(t as object).find((s) =>
    String(s).includes('Name'),
  );
  const name = sym ? (t as any)[sym] : undefined;
  return typeof name === 'string' ? name : 'unknown';
}

/**
 * THIS FAKE USED TO IGNORE `where()` TOO, patching every row in a table.
 *
 * Survivable while each test seeded exactly one provider row, and wrong the
 * moment one does not: `endStripeProviderRows` is scoped to
 * `provider = 'stripe'`, and the seventh incarnation is entirely about the
 * live LEMON SQUEEZY row beside it. A table-wide patch would kill that row
 * too, and the invariant assertion would then "pass" by proving the opposite.
 *
 * Interpreter ported from `webhook.provider-row.spec.ts`.
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

const mockDb: any = {
  select: () => {
    let target = 'unknown';
    let match: Predicate = () => true;
    const chain: any = {
      from: (t: unknown) => {
        target = tableName(t);
        return chain;
      },
      where: (c: unknown) => {
        match = predicateFrom(c);
        return chain;
      },
      limit: () => chain,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(rowsOf(target).filter(match)).then(resolve),
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
  insert: () => {
    const chain: any = {
      values: () => chain,
      onConflictDoUpdate: () => chain,
      returning: () => Promise.resolve([{ id: 1 }]),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve([{ id: 1 }]).then(resolve),
    };
    return chain;
  },
};

jest.mock('../../drizzle/db', () => ({ db: mockDb }));

import { SubscriptionService } from './subscription.service';
// The REAL liveness predicate the billing branches read.
import { isLive } from './provider-subscription.util';

const SUBSCRIPTION_ID = 42;

function seed(): void {
  tables = {
    workspace: [{ id: 'ws-1', ownerId: 'user-1' }],
    subscriptions: [
      {
        id: SUBSCRIPTION_ID,
        userId: 'user-1',
        planCode: 'PRO',
        status: 'active',
        stripeSubscriptionId: 'sub_dead',
      },
    ],
    provider_subscriptions: [
      {
        id: 1,
        subscriptionId: SUBSCRIPTION_ID,
        provider: 'stripe',
        itemType: 'BASE_PLAN',
        providerSubscriptionId: 'sub_dead',
        providerStatus: 'active',
        isDefault: true,
      },
    ],
    subscription_items: [{ id: 1, subscriptionId: SUBSCRIPTION_ID }],
  };
}

function makeService(): SubscriptionService {
  return new SubscriptionService(
    { getSubscription: jest.fn() } as never,
    { getOrCreateStripeCustomer: jest.fn() } as never,
    { findByUserId: jest.fn() } as never,
    { adapterFor: jest.fn(), adapterForSubscription: jest.fn() } as never,
  );
}

beforeEach(() => {
  seed();
  jest.clearAllMocks();
});

describe('resetBillingState', () => {
  it('leaves no live provider row for the dead subscription', async () => {
    await makeService().resetBillingState('ws-1', 'user-1');

    // The state, not the call. A row still reading `active` means
    // `hasLiveBasePlan()` says this account pays someone, and the re-subscribe
    // this endpoint exists to unblock hands Stripe `sub_dead` and 500s.
    expect(rowsOf('provider_subscriptions')[0].providerStatus).toBe('canceled');
  });

  it('releases the is_default slot', async () => {
    await makeService().resetBillingState('ws-1', 'user-1');

    // One true row per subscription is all the partial unique index allows; a
    // dead row holding it makes a later Lemon Squeezy signup raise 23505 after
    // LS has charged.
    expect(rowsOf('provider_subscriptions')[0].isDefault).toBe(false);
  });

  it('hands is_default to a live LEMON SQUEEZY row instead of stranding it', async () => {
    // C1 through THIS endpoint. The reviewer named it as a trigger in its own
    // right: `POST /billing/reset` on an account holding both providers.
    // `endStripeProviderRows` is scoped to `provider = 'stripe'`, so the live
    // Lemon Squeezy row survives untouched — the account is still being billed
    // — and before the fix nothing handed the flag on. Zero defaults while LS
    // charges makes `hasLiveBasePlan` answer false for a paying customer, and
    // the very re-subscribe this endpoint exists to unblock then opens a
    // SECOND live subscription.
    rowsOf('provider_subscriptions').push({
      id: 2,
      subscriptionId: SUBSCRIPTION_ID,
      provider: 'lemonsqueezy',
      itemType: 'BASE_PLAN',
      providerSubscriptionId: 'ls_sub_1',
      providerStatus: 'active',
      providerQuantity: 1,
      endsAt: null,
      isDefault: false,
    });

    await makeService().resetBillingState('ws-1', 'user-1');

    const rows = rowsOf('provider_subscriptions');
    const stripeRow = rows.find((r) => r.provider === 'stripe') as Row;
    const lsRow = rows.find((r) => r.provider === 'lemonsqueezy') as Row;

    // The Lemon Squeezy row is untouched by the Stripe-scoped UPDATE...
    expect(lsRow.providerStatus).toBe('active');
    // ...and it inherits the flag the dead Stripe row released.
    expect(lsRow.isDefault).toBe(true);
    expect(stripeRow.isDefault).toBe(false);

    // The invariant, not just the field.
    const defaults = rows.filter((r) => r.isDefault === true);
    expect(defaults).toHaveLength(1);
    expect(isLive(defaults[0] as never)).toBe(true);
  });

  it('still clears the legacy column and returns to FREE', async () => {
    await makeService().resetBillingState('ws-1', 'user-1');

    const sub = rowsOf('subscriptions')[0];
    expect(sub.stripeSubscriptionId).toBeNull();
    expect(sub.planCode).toBe('FREE');
  });
});
