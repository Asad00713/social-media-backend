/**
 * The account shape that ACTUALLY exists in production, today.
 *
 * Every paying customer right now is a Stripe customer created before
 * `provider_subscriptions` existed: `subscriptions.stripe_subscription_id` is
 * set, and the account has ZERO provider rows, because until this fix nothing
 * in the codebase ever wrote a BASE_PLAN one — the only INSERT was inside
 * `StripeAdapter.purchaseAddon`, and it writes add-on item types.
 *
 * `hasLiveBasePlan()` therefore returned false for the entire paying
 * population, and the sibling spec (`plan-change.provider-routing.spec.ts`)
 * could not see it: those tests hand-feed provider rows as `selectResults[3]`,
 * so the code and the test agreed with each other about a table neither had
 * ever seen populated.
 *
 * What that cost, and what these two tests pin:
 *
 *   1. `downgradeToFree` read "nothing is being billed", flipped the row to
 *      FREE, deleted the subscription_items and RETURNED before reaching
 *      `adapter.cancel` — Stripe went on charging the customer forever.
 *
 *   2. `changePlan` read "not already paying", so a paid→paid change fell into
 *      the FREE→paid branch and created a SECOND live Stripe subscription. The
 *      subscriptions row was then overwritten with the new id, orphaning the
 *      original beyond any means of cancelling it.
 *
 * ts-jest runs transpile-only here (`isolatedModules`), so a type-level
 * assertion would be VACUOUS at runtime. Every assertion below is on a runtime
 * value.
 */

const mockDb = {
  select: jest.fn(),
  update: jest.fn(),
  insert: jest.fn(),
  delete: jest.fn(),
};

jest.mock('../../drizzle/db', () => ({ db: mockDb }));

/**
 * The direct-subscribe call is what "a second Stripe subscription" MEANS here,
 * so it is stubbed rather than allowed near a network: if `changePlan` reaches
 * it for an account that already pays, that is the double-billing bug.
 */
const mockCreateStripeSubscriptionDirect = jest.fn();
jest.mock('../providers/stripe-direct-subscribe.util', () => ({
  createStripeSubscriptionDirect: (...args: unknown[]) =>
    mockCreateStripeSubscriptionDirect(...args) as unknown,
}));

/**
 * Only the WRITE is stubbed, to keep it out of these tests' `mockDb` call
 * ordering. `expireStripeProviderRows` is deliberately left REAL — the stale
 * test below turns on it actually running, and stubbing it would make that
 * test pass whether or not the fix is present.
 */
const actualProviderRowUtil = jest.requireActual<
  typeof import('../providers/stripe-provider-row.util')
>('../providers/stripe-provider-row.util');
jest.mock('../providers/stripe-provider-row.util', () => ({
  writeStripeBasePlanRow: jest.fn().mockResolvedValue(undefined),
  expireStripeProviderRows: (subscriptionId: number) =>
    actualProviderRowUtil.expireStripeProviderRows(subscriptionId),
}));

/**
 * Stripe-only proration plumbing that runs AFTER the routing decision under
 * test. Stubbed because it reaches for a real Stripe client; reaching it at
 * all already proves the upgrade took the correct paid→paid branch.
 */
jest.mock('../providers/stripe-immediate-invoice.util', () => ({
  invoiceStripeProrationsImmediately: jest.fn().mockResolvedValue(undefined),
}));

import { PlanChangeService } from './plan-change.service';

/* The fakes below stand in for drizzle's fluent builders, whose chain types are
   not expressible here — `any` is deliberate and confined to the fakes. */
/* eslint-disable @typescript-eslint/no-unsafe-return */

let selectResults: unknown[][];

function makeSelectChain(): any {
  const rows = selectResults.shift() ?? [];
  const chain: any = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve),
  };
  return chain;
}

function makeWriteChain(): any {
  const chain: any = {
    set: () => chain,
    values: () => chain,
    where: () => chain,
    returning: () => Promise.resolve([{ id: 1 }]),
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve([{ id: 1 }]).then(resolve),
  };
  return chain;
}

/**
 * A REAL Stripe subscriber as production holds one: the Stripe id is set and
 * there is not a single `provider_subscriptions` row anywhere.
 */
const STRIPE_SUBSCRIPTION = {
  id: 42,
  userId: 'user-1',
  planCode: 'BASIC',
  status: 'active',
  stripeCustomerId: 'cus_live',
  stripeSubscriptionId: 'sub_live',
  currentPeriodEnd: new Date('2026-10-01'),
};

/** The whole point: production has NO provider rows for these accounts. */
const NO_PROVIDER_ROWS: unknown[] = [];

const PRO_PLAN = {
  id: 2,
  code: 'PRO',
  name: 'Pro',
  basePriceCents: 20000,
  stripePriceId: 'price_pro',
  channelsPerWorkspace: 10,
  membersPerWorkspace: 5,
  maxWorkspaces: 3,
  aiTokensPerMonth: 1000,
  queuedPostsPerChannel: 100,
};

const FREE_PLAN = {
  id: 1,
  code: 'FREE',
  name: 'Free',
  basePriceCents: 0,
  stripePriceId: null,
  channelsPerWorkspace: 3,
  membersPerWorkspace: 1,
  maxWorkspaces: 1,
  aiTokensPerMonth: 0,
  queuedPostsPerChannel: 10,
};

const WORKSPACE_ROW = { id: 'ws-1', ownerId: 'user-1' };

interface Harness {
  service: PlanChangeService;
  adapter: { name: string; changePlan: jest.Mock; cancel: jest.Mock };
  stripeService: { getSubscription: jest.Mock; getClient: jest.Mock };
}

function makeService(): Harness {
  const adapter = {
    name: 'stripe',
    changePlan: jest.fn().mockResolvedValue(undefined),
    cancel: jest.fn().mockResolvedValue(undefined),
  };

  const providers = {
    adapterForSubscription: jest.fn().mockResolvedValue(adapter),
    adapterFor: jest.fn().mockResolvedValue(adapter),
  };

  const usageService = {
    canDowngrade: jest
      .fn()
      .mockResolvedValue({ canDowngrade: true, issues: [] }),
  };

  const lookup = {
    applyLimitsToAllWorkspaces: jest.fn().mockResolvedValue(undefined),
    getAddonQuantities: jest.fn().mockResolvedValue({}),
  };

  const notificationEmitter = {
    planChanged: jest.fn().mockResolvedValue(undefined),
  };

  // The stale-subscription check runs for Stripe accounts and must find the
  // id ALIVE — a stale id is a different scenario (see the C2 spec).
  const stripeService = {
    getSubscription: jest.fn().mockResolvedValue({ id: 'sub_live' }),
    getClient: jest.fn(),
  };

  const service = new PlanChangeService(
    stripeService as never,
    usageService as never,
    lookup as never,
    notificationEmitter as never,
    providers as never,
  );

  return { service, adapter, stripeService };
}

beforeEach(() => {
  jest.clearAllMocks();
  selectResults = [];
  mockDb.select.mockImplementation(() => makeSelectChain());
  mockDb.update.mockImplementation(() => makeWriteChain());
  mockDb.insert.mockImplementation(() => makeWriteChain());
  mockDb.delete.mockImplementation(() => makeWriteChain());
  mockCreateStripeSubscriptionDirect.mockResolvedValue({
    id: 'sub_SECOND',
    items: { data: [{ id: 'si_second' }] },
  });
});

describe('a real Stripe subscriber with no provider rows (production shape)', () => {
  it('downgradeToFree still cancels at Stripe instead of silently stripping the plan', async () => {
    const { service, adapter } = makeService();

    selectResults = [
      [WORKSPACE_ROW], // ownership check
      [STRIPE_SUBSCRIPTION], // the account — stripeSubscriptionId IS set
      [FREE_PLAN], // FREE plan limits
      NO_PROVIDER_ROWS, // provider_subscriptions: empty, as in production
    ];

    await service.downgradeToFree('ws-1', 'user-1');

    // The bug: this was never reached. The customer was flipped to FREE, their
    // subscription_items deleted, and Stripe billed them indefinitely.
    expect(adapter.cancel).toHaveBeenCalledWith(42, true);
  });

  it('changePlan on a paid→paid upgrade does not create a SECOND Stripe subscription', async () => {
    const { service, adapter } = makeService();

    jest.spyOn(service, 'previewPlanChange').mockResolvedValue({
      currentPlan: { code: 'BASIC', name: 'Basic', priceCents: 10000 },
      newPlan: { code: 'PRO', name: 'Pro', priceCents: 20000 },
      isUpgrade: true,
      proratedAmountCents: 0,
      effectiveDate: '2026-10-01',
      newLimits: {
        channelsPerWorkspace: 10,
        membersPerWorkspace: 5,
        maxWorkspaces: 3,
      },
      validationIssues: [],
      canChange: true,
    });

    selectResults = [
      [STRIPE_SUBSCRIPTION], // the account
      [PRO_PLAN], // target plan
      NO_PROVIDER_ROWS, // provider_subscriptions: empty
      [], // base subscription_item lookup
    ];

    await service.changePlan('ws-1', 'user-1', 'PRO');

    // The bug: `isAlreadyPaying` was false, so the FREE→paid branch ran and
    // created a whole second live subscription at Stripe. The original was
    // then orphaned — the id it was stored under got overwritten — so nothing
    // could ever cancel it. The customer paid for both.
    expect(mockCreateStripeSubscriptionDirect).not.toHaveBeenCalled();

    // ...and the change went through the existing subscription instead.
    expect(adapter.changePlan).toHaveBeenCalledWith(42, 'PRO');
  });

  /**
   * The legacy fallback must not resurrect a DEAD Stripe id.
   *
   * `clearStaleStripeSubscription` nulls the column (and now expires the
   * provider rows) precisely so the caller falls through to Checkout. If the
   * fallback read the column without regard to that, a stale account would go
   * back to `adapter.changePlan` -> `stripe.updateSubscription(<dead id>)` ->
   * `resource_missing` 500, which is the exact crash the recovery exists to
   * prevent.
   */
  it('a stale Stripe id still routes to the Checkout path, not back to the adapter', async () => {
    const { service, adapter, stripeService } = makeService();

    // Stripe says the stored id no longer exists.
    stripeService.getSubscription.mockRejectedValue(
      Object.assign(new Error('No such subscription'), {
        code: 'resource_missing',
      }),
    );

    jest.spyOn(service, 'previewPlanChange').mockResolvedValue({
      currentPlan: { code: 'BASIC', name: 'Basic', priceCents: 10000 },
      newPlan: { code: 'PRO', name: 'Pro', priceCents: 20000 },
      isUpgrade: true,
      proratedAmountCents: 0,
      effectiveDate: '2026-10-01',
      newLimits: {
        channelsPerWorkspace: 10,
        membersPerWorkspace: 5,
        maxWorkspaces: 3,
      },
      validationIssues: [],
      canChange: true,
    });

    selectResults = [
      [{ ...STRIPE_SUBSCRIPTION }], // fresh copy: the stale check mutates it
      [PRO_PLAN],
      NO_PROVIDER_ROWS,
      [],
    ];

    await service.changePlan('ws-1', 'user-1', 'PRO');

    // The dead id was never handed back to the provider...
    expect(adapter.changePlan).not.toHaveBeenCalled();
    // ...and a fresh subscription was created instead, as designed.
    expect(mockCreateStripeSubscriptionDirect).toHaveBeenCalled();
  });

  /**
   * The same recovery, for a BACKFILLED account — the case migration 0034
   * creates, and the one C2 is actually about.
   *
   * Here the Stripe provider row EXISTS and reads live, so nulling
   * `stripe_subscription_id` alone changes nothing: `hasLiveBasePlan` still
   * finds a live BASE_PLAN row, `isAlreadyPaying` stays true, and the dead id
   * goes straight to `adapter.changePlan` ->
   * `stripe.updateSubscription(<dead id>)` -> `resource_missing` 500. The
   * whole stated purpose of `clearStaleStripeSubscription` — route to Checkout
   * instead of crashing — was defeated.
   *
   * This test turns on `expireStripeProviderRows` actually running, which is
   * why the mock DB below models the write rather than swallowing it.
   */
  it('expires the provider rows too, so a backfilled stale account also reaches Checkout', async () => {
    const { service, adapter, stripeService } = makeService();

    stripeService.getSubscription.mockRejectedValue(
      Object.assign(new Error('No such subscription'), {
        code: 'resource_missing',
      }),
    );

    // A live Stripe BASE_PLAN row, as 0034 backfills for every existing
    // subscriber. Mutable on purpose: the fake `update` below writes into it,
    // so the later provider-row read sees what the fix actually did.
    const liveStripeRow: Record<string, unknown> = {
      id: 7,
      subscriptionId: 42,
      provider: 'stripe',
      itemType: 'BASE_PLAN',
      providerSubscriptionId: 'sub_live',
      providerItemId: 'si_live',
      providerQuantity: 1,
      providerStatus: 'active',
      endsAt: null,
      isDefault: true,
    };

    // Model the one write that matters: `.set({ providerStatus })` lands on the
    // row. Without this the fake DB would report success while changing
    // nothing, and the assertion below could not tell the fix from its absence.
    mockDb.update.mockImplementation(() => {
      const chain: any = {
        set: (values: Record<string, unknown>) => {
          if (typeof values.providerStatus === 'string') {
            liveStripeRow.providerStatus = values.providerStatus;
          }
          return chain;
        },
        where: () => chain,
        returning: () => Promise.resolve([{ id: 1 }]),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve([{ id: 1 }]).then(resolve),
      };
      return chain;
    });

    jest.spyOn(service, 'previewPlanChange').mockResolvedValue({
      currentPlan: { code: 'BASIC', name: 'Basic', priceCents: 10000 },
      newPlan: { code: 'PRO', name: 'Pro', priceCents: 20000 },
      isUpgrade: true,
      proratedAmountCents: 0,
      effectiveDate: '2026-10-01',
      newLimits: {
        channelsPerWorkspace: 10,
        membersPerWorkspace: 5,
        maxWorkspaces: 3,
      },
      validationIssues: [],
      canChange: true,
    });

    selectResults = [
      [{ ...STRIPE_SUBSCRIPTION }],
      [PRO_PLAN],
      [liveStripeRow], // read AFTER the stale clear — must now say expired
      [],
    ];

    await service.changePlan('ws-1', 'user-1', 'PRO');

    // The row was expired, not left claiming to bill...
    expect(liveStripeRow.providerStatus).toBe('expired');
    // ...so the dead id never went back to Stripe...
    expect(adapter.changePlan).not.toHaveBeenCalled();
    // ...and the account was routed to a fresh subscription instead.
    expect(mockCreateStripeSubscriptionDirect).toHaveBeenCalled();
  });
});
