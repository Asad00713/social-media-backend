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
/* eslint-disable @typescript-eslint/no-unsafe-call */
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

function rowsOf(name: string): Row[] {
  tables[name] = tables[name] ?? [];
  return tables[name];
}

const mockDb: any = {
  select: () => {
    let target = 'unknown';
    const chain: any = {
      from: (t: unknown) => {
        target = tableName(t);
        return chain;
      },
      where: () => chain,
      limit: () => chain,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(rowsOf(target)).then(resolve),
    };
    return chain;
  },
  update: (t: unknown) => {
    const target = tableName(t);
    let patch: Row = {};
    const apply = (): void => {
      for (const row of rowsOf(target)) Object.assign(row, patch);
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
    const chain: any = {
      where: () => {
        tables[target] = [];
        return chain;
      },
      then: (resolve: (v: unknown) => unknown) => {
        tables[target] = [];
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

  it('still clears the legacy column and returns to FREE', async () => {
    await makeService().resetBillingState('ws-1', 'user-1');

    const sub = rowsOf('subscriptions')[0];
    expect(sub.stripeSubscriptionId).toBeNull();
    expect(sub.planCode).toBe('FREE');
  });
});
