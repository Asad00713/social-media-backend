/**
 * `cancelForAccount`: the one place a subscription is cancelled, for the
 * cancel route, the last-workspace delete and the account delete. Provider
 * HTTP never runs: the adapter is a stub, and the module-level `db` is a
 * fake whose `select` hands back queued rows in call order.
 */

const mockDb = {
  select: jest.fn(),
  insert: jest.fn(),
  update: jest.fn(),
};

jest.mock('../../drizzle/db', () => ({ db: mockDb }));

import { BillingController } from '../billing.controller';
import { SubscriptionService, isCancellable } from './subscription.service';

/* The fakes stand in for drizzle's fluent builders; `any` is confined to them. */
/* eslint-disable @typescript-eslint/no-unsafe-return */

let selectResults: unknown[][];
let inserted: unknown[];
let updated: unknown[];

function selectChain(): any {
  const rows = selectResults.shift() ?? [];
  const chain: any = {
    from: () => chain,
    where: () => chain,
    limit: () => chain,
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve),
  };
  return chain;
}

const PRO = {
  id: 11,
  userId: 'owner-1',
  planCode: 'PRO',
  status: 'active',
  currentPeriodEnd: new Date('2027-02-01T00:00:00Z'),
  cancelAtPeriodEnd: false,
};

function make() {
  const adapter = { cancel: jest.fn().mockResolvedValue(undefined) };
  const providers = {
    adapterForSubscription: jest.fn().mockResolvedValue(adapter),
  };
  const service = new SubscriptionService(
    {} as never,
    {} as never,
    {} as never,
    providers as never,
  );
  return { service, adapter, providers };
}

beforeEach(() => {
  jest.clearAllMocks();
  selectResults = [];
  inserted = [];
  updated = [];
  mockDb.select.mockImplementation(selectChain);
  mockDb.insert.mockImplementation(() => ({
    values: (v: unknown) => {
      inserted.push(v);
      return Promise.resolve();
    },
  }));
  mockDb.update.mockImplementation(() => ({
    set: (v: unknown) => {
      updated.push(v);
      return { where: () => Promise.resolve() };
    },
  }));
});

describe('SubscriptionService.cancelForAccount', () => {
  it('cancels at the provider, marks the row, and logs the change with its reason', async () => {
    const { service, adapter } = make();
    selectResults = [[PRO]];

    await expect(
      service.cancelForAccount('owner-1', true, {
        reason: 'too_expensive',
        changedByUserId: 'owner-1',
      }),
    ).resolves.toBe('cancelled');

    expect(adapter.cancel).toHaveBeenCalledWith(11, true);
    expect(updated).toEqual([
      expect.objectContaining({ cancelAtPeriodEnd: true }),
    ]);
    expect(inserted).toEqual([
      {
        subscriptionId: 11,
        changeType: 'SUBSCRIPTION_CANCELLED',
        newValue: { atPeriodEnd: true },
        changedByUserId: 'owner-1',
        reason: 'too_expensive',
      },
    ]);
  });

  it('an immediate cancel sets the row canceled; reason and actor default to null', async () => {
    const { service } = make();
    selectResults = [[PRO]];

    await service.cancelForAccount('owner-1', false);

    expect(updated).toEqual([
      expect.objectContaining({
        status: 'canceled',
        canceledAt: expect.any(Date) as unknown,
      }),
    ]);
    expect(inserted).toEqual([
      expect.objectContaining({
        newValue: { atPeriodEnd: false },
        changedByUserId: null,
        reason: null,
      }),
    ]);
  });

  it.each([
    ['FREE', [{ ...PRO, planCode: 'FREE' }]],
    ['already canceled', [{ ...PRO, status: 'canceled' }]],
    ['incomplete_expired', [{ ...PRO, status: 'incomplete_expired' }]],
    ['expired', [{ ...PRO, status: 'expired' }]],
    ['no subscription', []],
  ])('%s: none, and no provider call or write', async (_label, rows) => {
    const { service, adapter, providers } = make();
    selectResults = [rows];

    await expect(service.cancelForAccount('owner-1', true)).resolves.toBe(
      'none',
    );
    expect(providers.adapterForSubscription).not.toHaveBeenCalled();
    expect(adapter.cancel).not.toHaveBeenCalled();
    expect(updated).toEqual([]);
    expect(inserted).toEqual([]);
  });
});

describe('cancel twice', () => {
  it('already set to end at the period end: none, no provider call, no second SUBSCRIPTION_CANCELLED row', async () => {
    const { service, adapter, providers } = make();
    selectResults = [[{ ...PRO, cancelAtPeriodEnd: true }]];

    await expect(
      service.cancelForAccount('owner-1', true, { reason: 'too_expensive' }),
    ).resolves.toBe('none');
    expect(providers.adapterForSubscription).not.toHaveBeenCalled();
    expect(adapter.cancel).not.toHaveBeenCalled();
    expect(updated).toEqual([]);
    expect(inserted).toEqual([]);
  });

  it('already ending at the period end, an immediate cancel still goes through', async () => {
    const { service, adapter } = make();
    selectResults = [[{ ...PRO, cancelAtPeriodEnd: true }]];

    await expect(service.cancelForAccount('owner-1', false)).resolves.toBe(
      'cancelled',
    );
    expect(adapter.cancel).toHaveBeenCalledWith(11, false);
  });

  it('the route answers 400 when the plan is already ending', async () => {
    const { service, adapter } = make();
    const ending = { ...PRO, cancelAtPeriodEnd: true };
    selectResults = [[{ id: 'ws-1' }], [ending], [ending]];

    await expect(
      service.cancelSubscription('ws-1', 'owner-1', true),
    ).rejects.toMatchObject({
      status: 400,
      message:
        'Subscription is already set to cancel at the end of the billing period',
    });
    expect(adapter.cancel).not.toHaveBeenCalled();
  });
});

describe('isCancellable', () => {
  it.each([
    ['no subscription', null, true, false],
    ['FREE by code', { ...PRO, planCode: 'FREE' }, true, false],
    ['canceled', { ...PRO, status: 'canceled' }, true, false],
    ['active PRO', PRO, true, true],
    ['paused PRO', { ...PRO, status: 'paused' }, true, true],
    [
      'ending, asked at period end',
      { ...PRO, cancelAtPeriodEnd: true },
      true,
      false,
    ],
    ['ending, asked now', { ...PRO, cancelAtPeriodEnd: true }, false, true],
  ])('%s', (_label, sub, atPeriodEnd, expected) => {
    expect(isCancellable(sub, atPeriodEnd)).toBe(expected);
  });
});

describe('SubscriptionService.cancelSubscription (route)', () => {
  it('keeps the owner check and delegates with the reason', async () => {
    const { service } = make();
    // owner check, the route's own read, cancelForAccount's read
    selectResults = [[{ id: 'ws-1' }], [PRO], [PRO]];
    const spy = jest.spyOn(service, 'cancelForAccount');

    const res = await service.cancelSubscription(
      'ws-1',
      'owner-1',
      true,
      'switching_tool',
    );

    expect(spy).toHaveBeenCalledWith('owner-1', true, {
      reason: 'switching_tool',
      changedByUserId: 'owner-1',
    });
    expect(res.message).toContain('end of the billing period');
    expect(inserted).toEqual([
      expect.objectContaining({ reason: 'switching_tool' }),
    ]);
  });

  it('a non-owner gets 404 and nothing is cancelled', async () => {
    const { service, adapter } = make();
    selectResults = [[]];

    await expect(
      service.cancelSubscription('ws-1', 'stranger', true),
    ).rejects.toMatchObject({ status: 404 });
    expect(adapter.cancel).not.toHaveBeenCalled();
  });

  it('FREE still answers 400 Cannot cancel free plan', async () => {
    const { service } = make();
    selectResults = [[{ id: 'ws-1' }], [{ ...PRO, planCode: 'FREE' }]];

    await expect(
      service.cancelSubscription('ws-1', 'owner-1', true),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Cannot cancel free plan',
    });
  });
});

describe('BillingController.cancelSubscription', () => {
  it('passes the body reason through', async () => {
    const subscriptionService = {
      cancelSubscription: jest.fn().mockResolvedValue({ message: 'ok' }),
    };
    // The handler alone: the module's DI graph is not the unit here.
    const controller = Object.create(
      BillingController.prototype,
    ) as BillingController;
    Object.assign(controller, { subscriptionService });

    await controller.cancelSubscription(
      'ws-1',
      { userId: 'owner-1', email: 'o@example.test' },
      { cancelAtPeriodEnd: false, reason: 'taking_break' },
    );

    expect(subscriptionService.cancelSubscription).toHaveBeenCalledWith(
      'ws-1',
      'owner-1',
      false,
      'taking_break',
    );
  });
});

/** A BASE_PLAN provider row, the default provider's. */
const baseRow = (providerStatus: string, over: object = {}) => ({
  id: 1,
  subscriptionId: 11,
  provider: 'stripe',
  itemType: 'BASE_PLAN',
  isDefault: true,
  providerStatus,
  providerSubscriptionId: 'sub_1',
  endsAt: null,
  ...over,
});

describe("cancelForAccount and the provider's own state", () => {
  it.each(['canceled', 'incomplete_expired', 'expired', 'removed'])(
    'a local row still active but a BASE_PLAN row %s: none, the provider is never called',
    async (status) => {
      const { service, adapter } = make();
      selectResults = [[PRO], [baseRow(status)]];
      await expect(service.cancelForAccount('owner-1', false)).resolves.toBe(
        'none',
      );
      expect(adapter.cancel).not.toHaveBeenCalled();
      expect(updated).toEqual([]);
    },
  );

  it('a live BASE_PLAN row (Lemon Squeezy cancelled before ends_at counts as live) is cancelled', async () => {
    const { service, adapter } = make();
    selectResults = [
      [PRO],
      [
        baseRow('cancelled', {
          provider: 'lemonsqueezy',
          endsAt: new Date(Date.now() + 86_400_000),
        }),
      ],
    ];
    await expect(service.cancelForAccount('owner-1', false)).resolves.toBe(
      'cancelled',
    );
    expect(adapter.cancel).toHaveBeenCalledWith(11, false);
  });

  it.each([
    [
      'Stripe resource_missing',
      Object.assign(new Error('No such subscription: sub_1'), {
        code: 'resource_missing',
      }),
    ],
    [
      'Stripe already canceled',
      new Error(
        'A canceled subscription can only update its cancellation_details and metadata.',
      ),
    ],
    [
      'Lemon Squeezy 404',
      new Error('Lemon Squeezy DELETE subscriptions/9 failed: HTTP 404'),
    ],
  ])('goneIsCancelled: %s is recorded as cancelled', async (_label, error) => {
    const { service, adapter } = make();
    adapter.cancel.mockRejectedValue(error);
    selectResults = [[PRO], [baseRow('active')]];
    await expect(
      service.cancelForAccount('owner-1', false, { goneIsCancelled: true }),
    ).resolves.toBe('cancelled');
    expect(updated).toEqual([expect.objectContaining({ status: 'canceled' })]);
  });

  it('without goneIsCancelled the same refusal still fails', async () => {
    const { service, adapter } = make();
    adapter.cancel.mockRejectedValue(
      Object.assign(new Error('No such subscription'), {
        code: 'resource_missing',
      }),
    );
    selectResults = [[PRO], [baseRow('active')]];
    await expect(service.cancelForAccount('owner-1', false)).rejects.toThrow(
      'No such subscription',
    );
    expect(updated).toEqual([]);
  });

  it('goneIsCancelled never swallows a real failure (timeout, 5xx)', async () => {
    const { service, adapter } = make();
    adapter.cancel.mockRejectedValue(
      new Error('Lemon Squeezy DELETE subscriptions/9 timed out after 10000ms'),
    );
    selectResults = [[PRO], [baseRow('active')]];
    await expect(
      service.cancelForAccount('owner-1', false, { goneIsCancelled: true }),
    ).rejects.toThrow('timed out');
    expect(updated).toEqual([]);
  });
});

describe('isCancellable', () => {
  it('a terminal BASE_PLAN row wins over a local row that still says active', () => {
    expect(
      isCancellable(
        PRO as never,
        false,
        baseRow('incomplete_expired') as never,
      ),
    ).toBe(false);
    expect(isCancellable(PRO as never, false, baseRow('active') as never)).toBe(
      true,
    );
    expect(isCancellable(PRO as never, false, null)).toBe(true);
  });
});
