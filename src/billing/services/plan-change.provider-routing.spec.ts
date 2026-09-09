/**
 * Does a plan change actually REACH the right adapter?
 *
 * The isolation test proves no Stripe call escapes the adapters. It cannot
 * prove the routing picks the right adapter at runtime, and that gap hid two
 * critical bugs after Task 11 routed the calls: `changePlan` and
 * `downgradeToFree` still BRANCHED on `sub.stripeSubscriptionId`, a column
 * nothing writes for a Lemon Squeezy account.
 *
 * The effect for every LS customer:
 *  - `downgradeToFree` took the "nothing is being billed" path and returned
 *    without cancelling — stripped to FREE limits locally while Lemon Squeezy
 *    charged on, indefinitely, with no error.
 *  - `changePlan` fell past the routed branch into the FREE→paid branch and
 *    threw a spurious "Upgrading from FREE is not supported".
 *
 * So these tests pin the ROUTING, not the plumbing: given an account whose
 * `stripeSubscriptionId` is NULL but which holds live `provider_subscriptions`
 * rows, the adapter's method must be called.
 *
 * ts-jest is transpile-only here, so every assertion is on a runtime value.
 */

const mockDb = {
  select: jest.fn(),
  update: jest.fn(),
  insert: jest.fn(),
  delete: jest.fn(),
};

jest.mock('../../drizzle/db', () => ({ db: mockDb }));

import { PlanChangeService } from './plan-change.service';

/* The fakes below stand in for drizzle's fluent builders, whose chain types are
   not expressible here — `any` is deliberate and confined to the fakes. */
/* eslint-disable @typescript-eslint/no-unsafe-return */

/** Rows the fake `select` chain yields, in call order. */
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

const PRO_PLAN = {
  id: 2,
  code: 'PRO',
  name: 'Pro',
  basePriceCents: 20000,
  // Deliberately NULL: a Lemon Squeezy catalogue has no Stripe price. This is
  // what used to send an LS account down the wrong branch.
  stripePriceId: null,
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

/** An account billed by Lemon Squeezy: stripeSubscriptionId is NULL. */
const LS_SUBSCRIPTION = {
  id: 42,
  userId: 'user-1',
  planCode: 'BASIC',
  status: 'active',
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  currentPeriodEnd: new Date('2026-10-01'),
};

/** The `provider_subscriptions` row that says Lemon Squeezy IS billing them. */
const LS_PROVIDER_ROWS = [
  {
    id: 1,
    subscriptionId: 42,
    provider: 'lemonsqueezy',
    itemType: 'BASE_PLAN',
    providerSubscriptionId: 'ls-sub-1',
    providerItemId: 'ls-item-1',
    providerPriceId: 'variant-1',
    providerQuantity: 1,
    providerStatus: 'active',
    endsAt: null,
    isDefault: true,
  },
];

const WORKSPACE_ROW = { id: 'ws-1', ownerId: 'user-1' };

interface Harness {
  service: PlanChangeService;
  adapter: {
    name: string;
    changePlan: jest.Mock;
    cancel: jest.Mock;
  };
}

function makeService(): Harness {
  const adapter = {
    name: 'lemonsqueezy',
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

  const stripeService = {
    getSubscription: jest.fn(),
    getClient: jest.fn(),
  };

  const service = new PlanChangeService(
    stripeService as never,
    usageService as never,
    lookup as never,
    notificationEmitter as never,
    providers as never,
  );

  return { service, adapter };
}

beforeEach(() => {
  jest.clearAllMocks();
  selectResults = [];
  mockDb.select.mockImplementation(() => makeSelectChain());
  mockDb.update.mockImplementation(() => makeWriteChain());
  mockDb.insert.mockImplementation(() => makeWriteChain());
  mockDb.delete.mockImplementation(() => makeWriteChain());
});

describe('downgradeToFree routes to the account’s provider', () => {
  it('cancels at Lemon Squeezy even though stripeSubscriptionId is NULL', async () => {
    const { service, adapter } = makeService();

    selectResults = [
      [WORKSPACE_ROW], // ownership check
      [LS_SUBSCRIPTION], // the account's subscription
      [FREE_PLAN], // FREE plan limits
      LS_PROVIDER_ROWS, // provider_subscriptions — the real billing state
    ];

    await service.downgradeToFree('ws-1', 'user-1');

    // The bug: this was never called. The customer lost their limits and
    // Lemon Squeezy kept charging them.
    expect(adapter.cancel).toHaveBeenCalledWith(42, true);
  });

  it('skips the provider call when nothing is live at any provider', async () => {
    const { service, adapter } = makeService();

    selectResults = [
      [WORKSPACE_ROW],
      [LS_SUBSCRIPTION],
      [FREE_PLAN],
      [], // no provider_subscriptions rows: genuinely nothing being billed
    ];

    await service.downgradeToFree('ws-1', 'user-1');

    expect(adapter.cancel).not.toHaveBeenCalled();
  });

  it('skips the provider call once the base plan has expired', async () => {
    const { service, adapter } = makeService();

    selectResults = [
      [WORKSPACE_ROW],
      [LS_SUBSCRIPTION],
      [FREE_PLAN],
      [{ ...LS_PROVIDER_ROWS[0], providerStatus: 'expired' }],
    ];

    await service.downgradeToFree('ws-1', 'user-1');

    expect(adapter.cancel).not.toHaveBeenCalled();
  });
});

describe('changePlan routes a paid→paid change to the account’s provider', () => {
  /**
   * `previewPlanChange` runs first and does its own queries. Stubbing it keeps
   * these tests on the routing decision rather than on preview's fixtures.
   */
  function stubPreview(service: PlanChangeService, isUpgrade: boolean) {
    jest.spyOn(service, 'previewPlanChange').mockResolvedValue({
      currentPlan: { code: 'BASIC', name: 'Basic', priceCents: 10000 },
      newPlan: { code: 'PRO', name: 'Pro', priceCents: 20000 },
      isUpgrade,
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
  }

  it('calls adapter.changePlan on an upgrade, and does not throw the FREE-upgrade 400', async () => {
    const { service, adapter } = makeService();
    stubPreview(service, true);

    selectResults = [
      [LS_SUBSCRIPTION], // the account's subscription
      [PRO_PLAN], // target plan (stripePriceId is NULL)
      LS_PROVIDER_ROWS, // provider_subscriptions — already paying
      [], // base subscription_item lookup
    ];

    await expect(
      service.changePlan('ws-1', 'user-1', 'PRO'),
    ).resolves.toBeDefined();

    // The bug: this was skipped, and the FREE→paid branch threw
    // "Upgrading from FREE is not supported directly for lemonsqueezy".
    expect(adapter.changePlan).toHaveBeenCalledWith(42, 'PRO');
  });

  it('calls adapter.changePlan on a paid→paid downgrade rather than no-opping', async () => {
    const { service, adapter } = makeService();
    stubPreview(service, false);

    selectResults = [
      [LS_SUBSCRIPTION],
      [PRO_PLAN],
      LS_PROVIDER_ROWS,
      [], // base subscription_item lookup inside scheduleDowngrade
    ];

    await service.changePlan('ws-1', 'user-1', 'PRO');

    // The bug: the local DB was updated to the new plan while the provider was
    // never told, so the customer kept being billed at the old price.
    expect(adapter.changePlan).toHaveBeenCalledWith(42, 'PRO');
  });
});
