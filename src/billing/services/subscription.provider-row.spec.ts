/**
 * A new Stripe subscription must record itself in `provider_subscriptions`.
 *
 * This is the write path that never existed. Migration 0032 created the table,
 * six files were changed to read from it, and nothing wrote the BASE_PLAN row.
 * Migration 0034 backfills the accounts that already exist; these tests pin
 * that a subscription created FROM NOW ON does not reproduce the bug — a
 * subscription with no BASE_PLAN row reads as unbilled, so `downgradeToFree`
 * returns without cancelling (Stripe charges on forever) and a paid→paid
 * `changePlan` creates a second live subscription.
 *
 * `checkout.session.completed` is the main path (`persistStripeSubscription`),
 * and it is the one the webhook calls.
 *
 * ts-jest is transpile-only here, so every assertion is on a runtime value.
 */

const mockDb = {
  select: jest.fn(),
  insert: jest.fn(),
  update: jest.fn(),
};

jest.mock('../../drizzle/db', () => ({ db: mockDb }));

const mockWriteStripeBasePlanRow = jest.fn().mockResolvedValue(undefined);
jest.mock('../providers/stripe-provider-row.util', () => ({
  writeStripeBasePlanRow: (...args: unknown[]) =>
    mockWriteStripeBasePlanRow(...args) as unknown,
  expireStripeProviderRows: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./invoice-sync.util', () => ({
  upsertInvoiceFromStripe: jest.fn().mockResolvedValue(undefined),
}));

import { SubscriptionService } from './subscription.service';

/* The fakes stand in for drizzle's fluent builders; `any` is confined to them. */
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
    onConflictDoUpdate: () => chain,
    returning: () => Promise.resolve([{ id: 42 }]),
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve([{ id: 42 }]).then(resolve),
  };
  return chain;
}

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

const STRIPE_SUBSCRIPTION = {
  id: 'sub_new',
  status: 'active',
  cancel_at_period_end: false,
  items: {
    data: [
      {
        id: 'si_base',
        price: { id: 'price_pro' },
        current_period_start: 1_790_000_000,
        current_period_end: 1_800_000_000,
      },
    ],
  },
};

function makeService() {
  const lookup = {
    findByUserId: jest.fn().mockResolvedValue(null),
    getAddonQuantities: jest.fn().mockResolvedValue({
      extraChannels: 0,
      extraMembers: 0,
      extraWorkspaces: 0,
      extraAiTokens: 0,
    }),
  };

  return new SubscriptionService(
    { getSubscription: jest.fn() } as never,
    { getOrCreateStripeCustomer: jest.fn() } as never,
    lookup as never,
    { adapterFor: jest.fn(), adapterForSubscription: jest.fn() } as never,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  selectResults = [];
  mockDb.select.mockImplementation(() => makeSelectChain());
  mockDb.insert.mockImplementation(() => makeWriteChain());
  mockDb.update.mockImplementation(() => makeWriteChain());
});

describe('persistStripeSubscription writes the provider record', () => {
  it('records the BASE_PLAN row so the account reads as billed', async () => {
    const service = makeService();

    selectResults = [
      [PRO_PLAN], // plan lookup
      [{ id: 'ws-1', createdAt: new Date('2026-01-01') }], // owned workspaces
      [{ id: 42 }], // the saved subscription id
    ];

    await service.persistStripeSubscription({
      userId: 'user-1',
      planCode: 'PRO',
      stripeCustomerId: 'cus_new',
      stripeSubscription: STRIPE_SUBSCRIPTION as never,
    });

    expect(mockWriteStripeBasePlanRow).toHaveBeenCalledTimes(1);

    const calls = mockWriteStripeBasePlanRow.mock.calls as unknown[][];
    const arg = calls[0][0] as Record<string, unknown>;
    // Our subscription id, not Stripe's — the row is keyed on ours.
    expect(arg.subscriptionId).toBe(42);
    expect(arg.stripeCustomerId).toBe('cus_new');
    expect(arg.stripeSubscription).toBe(STRIPE_SUBSCRIPTION);
    expect(arg.unitPriceCents).toBe(20000);
  });
});
