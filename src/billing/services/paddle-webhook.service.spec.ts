/**
 * Paddle webhooks.
 *
 * Asserts on the RESULTING STATE of both tables after every event that ends,
 * suspends or starts a subscription — never on a function having been called.
 * ts-jest runs transpile-only, so a type-level assertion would be vacuous at
 * runtime; every assertion below is on a runtime value.
 *
 * The fake database is the shared, table-aware one from
 * `testing/fake-db.ts`: a positional queue would be table-blind, and a
 * write/read mismatch is the exact class of bug these tests exist to catch.
 */

/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { makeFakeDb, type Row } from './testing/fake-db';

const { store, db: mockDb } = makeFakeDb();
jest.mock('../../drizzle/db', () => ({ db: mockDb }));

import { PaddleWebhookService } from './paddle-webhook.service';
import { isLive } from './provider-subscription.util';

const PADDLE_SUB = 'sub_01paddle';
const PRICE_BASE = 'pri_base_pro';
const PRICE_CHANNEL = 'pri_channel';

interface Harness {
  service: PaddleWebhookService;
  limits: {
    applyLimitsToAllWorkspaces: jest.Mock;
    getAddonQuantities: jest.Mock;
  };
  alerts: { paymentFailed: jest.Mock; paymentSucceeded: jest.Mock };
  emails: {
    paymentFailed: jest.Mock;
    planName: jest.Mock;
    planChanged: jest.Mock;
  };
}

function seed(tables: Record<string, Row[]>): Harness {
  store.reset(tables);

  const limits = {
    applyLimitsToAllWorkspaces: jest.fn().mockResolvedValue(undefined),
    getAddonQuantities: jest.fn().mockResolvedValue({
      extraChannels: 0,
      extraMembers: 0,
      extraWorkspaces: 0,
      extraAiTokens: 0,
    }),
  };
  const alerts = {
    paymentFailed: jest.fn().mockResolvedValue(true),
    paymentSucceeded: jest.fn().mockResolvedValue(true),
  };

  const emails = {
    paymentFailed: jest.fn().mockResolvedValue(undefined),
    planName: jest.fn().mockResolvedValue('Basic'),
    planChanged: jest.fn().mockResolvedValue(undefined),
  };

  const service = new PaddleWebhookService(
    limits as never,
    alerts as never,
    emails as never,
  );
  return { service, limits, alerts, emails };
}

/** An account already billing through Paddle. */
function payingAccount(extra: Partial<Row> = {}) {
  return {
    subscriptions: [
      {
        id: 42,
        userId: 'user-1',
        planCode: 'PRO',
        status: 'active',
        cancelAtPeriodEnd: false,
      },
    ],
    provider_subscriptions: [
      {
        id: 1,
        subscriptionId: 42,
        provider: 'paddle',
        itemType: 'BASE_PLAN',
        providerSubscriptionId: PADDLE_SUB,
        providerPriceId: PRICE_BASE,
        providerQuantity: 1,
        providerStatus: 'active',
        isDefault: true,
        ...extra,
      },
    ],
    subscription_items: [],
  };
}

function subEvent(
  status: string,
  opts: {
    items?: { priceId: string; quantity: number }[];
    scheduledChange?: { action: string; effective_at?: string } | null;
    customData?: Record<string, unknown> | null;
    nextBilledAt?: string | null;
    canceledAt?: string | null;
  } = {},
) {
  const items = opts.items ?? [{ priceId: PRICE_BASE, quantity: 1 }];
  return {
    event_type: 'ignored-by-caller',
    data: {
      id: PADDLE_SUB,
      status,
      customer_id: 'ctm_1',
      next_billed_at: opts.nextBilledAt ?? '2026-12-25T00:00:00Z',
      canceled_at: opts.canceledAt ?? null,
      scheduled_change: opts.scheduledChange ?? null,
      custom_data: opts.customData ?? null,
      items: items.map((i) => ({
        price: { id: i.priceId, product_id: 'pro_x' },
        quantity: i.quantity,
      })),
    },
  };
}

const providerRows = () => store.rowsOf('provider_subscriptions');
const subRow = () => store.rowsOf('subscriptions')[0];

describe('PaddleWebhookService.verifySignature', () => {
  const OLD = process.env.PADDLE_WEBHOOK_SECRET;
  afterEach(() => {
    if (OLD === undefined) delete process.env.PADDLE_WEBHOOK_SECRET;
    else process.env.PADDLE_WEBHOOK_SECRET = OLD;
  });

  it('rejects when the secret is not configured', () => {
    // An unsigned, publicly reachable endpoint that mutates billing state is
    // worse than a dropped webhook Paddle will retry.
    delete process.env.PADDLE_WEBHOOK_SECRET;
    const { service } = seed(payingAccount());
    expect(service.verifySignature(Buffer.from('{}'), 'ts=1;h1=aa')).toBe(
      false,
    );
  });

  it('rejects a forged signature', () => {
    process.env.PADDLE_WEBHOOK_SECRET = 'secret';
    const { service } = seed(payingAccount());
    expect(service.verifySignature(Buffer.from('{}'), 'ts=1;h1=aa')).toBe(
      false,
    );
  });
});

describe('PaddleWebhookService: subscription.created', () => {
  it('attaches a new subscription to the account named in custom_data', async () => {
    // `createCheckout` writes no provider row — there is no subscription id
    // until Paddle makes one — so this event is where the first row appears.
    const { service } = seed({
      subscriptions: [
        { id: 42, userId: 'user-1', planCode: 'PRO', status: 'active' },
      ],
      provider_subscriptions: [],
    });

    await service.handleEvent(
      'subscription.created',
      subEvent('active', { customData: { user_id: 'user-1' } }),
    );

    expect(providerRows()).toHaveLength(1);
    expect(providerRows()[0]).toMatchObject({
      subscriptionId: 42,
      provider: 'paddle',
      itemType: 'BASE_PLAN',
      providerSubscriptionId: PADDLE_SUB,
      providerPriceId: PRICE_BASE,
      // THE base plan carries the flag: it names the provider billing the
      // account, and every liveness read funnels through it.
      isDefault: true,
    });
  });

  it('puts the account on the plan the checkout named', async () => {
    // THE point of the purchase. `applyStatus` carries the STATUS but never
    // the plan, so without this the customer pays, the provider row is
    // written, the status goes `active` — and `plan_code` stays FREE. They
    // are billed for Basic and hold Free's limits.
    //
    // Every other test in this file seeds an account ALREADY on a paid plan,
    // which is why 33 of them passed while this was broken. A new signup
    // starts on FREE, so that is what this seeds.
    const { service } = seed({
      subscriptions: [
        { id: 42, userId: 'user-1', planCode: 'FREE', status: 'active' },
      ],
      provider_subscriptions: [],
      plans: [{ code: 'BASIC' }, { code: 'PRO' }, { code: 'MAX' }],
    });

    await service.handleEvent(
      'subscription.created',
      subEvent('active', {
        customData: { user_id: 'user-1', plan_code: 'BASIC' },
      }),
    );

    expect(subRow()).toMatchObject({ planCode: 'BASIC' });
  });

  it('refreshes the workspace limits, not just the plan column', async () => {
    // `plan_code` is what the UI shows; `workspace_usage` is what GATES. They
    // are separate rows, and writing only the first leaves the account reading
    // "Basic plan" while still holding Free's channel, seat, AI and storage
    // limits — paying for a plan it cannot use. Caught in sandbox after the
    // plan column was already correct: 3/1/100 against Basic's 5/2/10000.
    const { service, limits } = seed({
      subscriptions: [
        { id: 42, userId: 'user-1', planCode: 'FREE', status: 'active' },
      ],
      provider_subscriptions: [],
      plans: [{ code: 'BASIC' }],
    });

    await service.handleEvent(
      'subscription.created',
      subEvent('active', {
        customData: { user_id: 'user-1', plan_code: 'BASIC' },
      }),
    );

    // Add-ons are zero: this is the base plan arriving, and an add-on bought
    // later fans its own limits out. Anything else would count it twice.
    expect(limits.applyLimitsToAllWorkspaces).toHaveBeenCalledWith(
      'user-1',
      'BASIC',
      {
        extraChannels: 0,
        extraMembers: 0,
        extraWorkspaces: 0,
        extraAiTokens: 0,
      },
    );
  });

  it('does not refresh limits for a plan it refused to apply', async () => {
    // An unknown plan code leaves the account where it was; raising limits for
    // a plan nothing can resolve would hand out entitlements nobody bought.
    const { service, limits } = seed({
      subscriptions: [
        { id: 42, userId: 'user-1', planCode: 'FREE', status: 'active' },
      ],
      provider_subscriptions: [],
      plans: [{ code: 'BASIC' }],
    });

    await service.handleEvent(
      'subscription.created',
      subEvent('active', {
        customData: { user_id: 'user-1', plan_code: 'ENTERPRISE_XL' },
      }),
    );

    expect(limits.applyLimitsToAllWorkspaces).not.toHaveBeenCalled();
  });

  it('applies the plan on a REDELIVERED created event, not just the first', async () => {
    // Paddle delivers at-least-once and out of order, so `subscription.created`
    // arriving twice is normal rather than exceptional.
    //
    // This is the test the first version of the fix would have failed. The
    // plan write lived inside `createRowFromCheckout`, which runs only when no
    // provider row exists yet — so a redelivery found the row, skipped the
    // creation, and skipped the plan with it. The account stayed on FREE while
    // paying for Basic, and no replay could repair it.
    //
    // Seeded with the row ALREADY present, which is exactly the state a
    // redelivery meets.
    const { service } = seed({
      subscriptions: [
        { id: 42, userId: 'user-1', planCode: 'FREE', status: 'active' },
      ],
      provider_subscriptions: [
        {
          id: 7,
          subscriptionId: 42,
          provider: 'paddle',
          itemType: 'BASE_PLAN',
          providerSubscriptionId: PADDLE_SUB,
          isDefault: true,
          providerStatus: 'active',
        },
      ],
      plans: [{ code: 'BASIC' }],
    });

    await service.handleEvent(
      'subscription.created',
      subEvent('active', {
        customData: { user_id: 'user-1', plan_code: 'BASIC' },
      }),
    );

    expect(subRow()).toMatchObject({ planCode: 'BASIC' });
    // And no duplicate row: the event is idempotent, not additive.
    expect(providerRows()).toHaveLength(1);
  });

  it('keeps the current plan when the checkout names an unknown one', async () => {
    // The code comes back over a public endpoint. An unvalidated value would
    // put an arbitrary string in the column every limit check reads — and a
    // plan nothing can resolve is worse than the plan they already had.
    const { service } = seed({
      subscriptions: [
        { id: 42, userId: 'user-1', planCode: 'FREE', status: 'active' },
      ],
      provider_subscriptions: [],
      plans: [{ code: 'BASIC' }],
    });

    await service.handleEvent(
      'subscription.created',
      subEvent('active', {
        customData: { user_id: 'user-1', plan_code: 'ENTERPRISE_XL' },
      }),
    );

    expect(subRow()).toMatchObject({ planCode: 'FREE' });
    // The attachment still happened: the payment is real and the row must not
    // be lost over bad metadata.
    expect(providerRows()).toHaveLength(1);
  });

  it('keeps the current plan when the checkout carries no plan_code', async () => {
    const { service } = seed({
      subscriptions: [
        { id: 42, userId: 'user-1', planCode: 'FREE', status: 'active' },
      ],
      provider_subscriptions: [],
      plans: [{ code: 'BASIC' }],
    });

    await service.handleEvent(
      'subscription.created',
      subEvent('active', { customData: { user_id: 'user-1' } }),
    );

    expect(subRow()).toMatchObject({ planCode: 'FREE' });
    expect(providerRows()).toHaveLength(1);
  });

  it('writes nothing when custom_data names no user', async () => {
    // Nothing is inferred from the email: two accounts can share one, and
    // billing the wrong one is not recoverable by a later event.
    const { service } = seed({
      subscriptions: [
        { id: 42, userId: 'user-1', planCode: 'PRO', status: 'active' },
      ],
      provider_subscriptions: [],
    });

    await service.handleEvent('subscription.created', subEvent('active'));

    expect(providerRows()).toHaveLength(0);
  });

  it('writes nothing when the named user has no subscription row', async () => {
    const { service } = seed({
      subscriptions: [],
      provider_subscriptions: [],
    });
    await service.handleEvent(
      'subscription.created',
      subEvent('active', { customData: { user_id: 'ghost' } }),
    );
    expect(providerRows()).toHaveLength(0);
  });

  it('a redelivery updates the row rather than duplicating it', async () => {
    // Paddle retries on any non-2xx. A second row would mean two live
    // subscriptions on one account.
    const { service } = seed({
      subscriptions: [
        { id: 42, userId: 'user-1', planCode: 'PRO', status: 'active' },
      ],
      provider_subscriptions: [],
    });

    const event = subEvent('active', { customData: { user_id: 'user-1' } });
    await service.handleEvent('subscription.created', event);
    await service.handleEvent('subscription.created', event);

    expect(providerRows()).toHaveLength(1);
  });

  it('refuses to create a row for any other event type', async () => {
    // An event for a subscription we hold no row for must not claim
    // `is_default` for an account whose provider is not yet decided.
    const { service } = seed({
      subscriptions: [
        { id: 42, userId: 'user-1', planCode: 'PRO', status: 'active' },
      ],
      provider_subscriptions: [],
    });

    await service.handleEvent(
      'subscription.updated',
      subEvent('active', { customData: { user_id: 'user-1' } }),
    );

    expect(providerRows()).toHaveLength(0);
  });
});

describe('PaddleWebhookService: subscription.updated', () => {
  it('records a pending cancellation from the SCHEDULED CHANGE', async () => {
    // Paddle keeps a cancelled-at-period-end subscription `active` and
    // records the intent in `scheduled_change`. Reading the status alone would
    // leave the customer with no sign their cancellation registered.
    const { service } = seed(payingAccount());

    await service.handleEvent(
      'subscription.updated',
      subEvent('active', {
        scheduledChange: {
          action: 'cancel',
          effective_at: '2026-12-25T00:00:00Z',
        },
      }),
    );

    expect(subRow()).toMatchObject({
      status: 'active',
      cancelAtPeriodEnd: true,
    });
    // Still billing until then, so the row keeps the default flag.
    expect(providerRows()[0].isDefault).toBe(true);
    expect(providerRows()[0].endsAt).toBeInstanceOf(Date);
  });

  it('does not read a scheduled PAUSE as a cancellation', async () => {
    const { service } = seed(payingAccount());
    await service.handleEvent(
      'subscription.updated',
      subEvent('active', { scheduledChange: { action: 'pause' } }),
    );
    expect(subRow().cancelAtPeriodEnd).toBe(false);
  });

  it('moves the account to past_due', async () => {
    const { service } = seed(payingAccount());
    await service.handleEvent('subscription.past_due', subEvent('past_due'));
    expect(subRow().status).toBe('past_due');
    // A past-due customer is still a customer whose card is being retried, so
    // the row stays live and keeps the flag.
    expect(providerRows()[0].isDefault).toBe(true);
    expect(isLive(providerRows()[0] as never)).toBe(true);
  });

  it('records the plan price and quantity the event carries', async () => {
    const { service } = seed(payingAccount());
    await service.handleEvent(
      'subscription.updated',
      subEvent('active', { items: [{ priceId: 'pri_base_max', quantity: 1 }] }),
    );
    expect(providerRows()[0].providerPriceId).toBe('pri_base_max');
  });
});

describe('PaddleWebhookService: termination', () => {
  it('writes the row dead AND releases is_default', async () => {
    // Both halves matter. A dead row that keeps the flag makes the account
    // read as paying while nothing bills it, and the partial unique index
    // allows exactly one `is_default` row — so the customer could never
    // re-subscribe.
    const { service } = seed(payingAccount());

    await service.handleEvent(
      'subscription.canceled',
      subEvent('canceled', { canceledAt: '2026-11-25T00:00:00Z' }),
    );

    const row = providerRows()[0];
    expect(row.isDefault).toBe(false);
    expect(row.renewsAt).toBeNull();
    expect(row.endsAt).toBeInstanceOf(Date);

    // Asserted through the REAL liveness predicate, not the status string.
    //
    // `applyStatus` writes `canceled` here and `revokeBasePlan` then
    // overwrites it with `expired` as it sweeps every row for the provider.
    // Both are in `isLive`'s deny-list, so the end state is correct either
    // way — and pinning the exact word would make this test fail the next
    // time one of those two writes changes while the account is still, truly,
    // not being billed. The invariant is the liveness, not the spelling.
    expect(isLive(row as never)).toBe(false);
    expect(['canceled', 'expired']).toContain(row.providerStatus);
  });

  it('releases is_default in applyStatus ITSELF, before the sweep', async () => {
    // `revokeBasePlan` also clears the flag as it sweeps every row for the
    // provider, which MASKS this write: removing `patch.isDefault = false`
    // from `applyStatus` left all 32 tests passing. That matters because the
    // two run in a fixed order for a reason — the flag must be released
    // BEFORE `rehomeDefault` looks for an heir, or the partial unique index
    // raises 23505 mid-webhook and Paddle retries forever against a state
    // that can never converge.
    //
    // So the sweep is taken out of the picture: a row on an account whose
    // `subscriptions` row is missing makes `revokeBasePlan` return before it
    // writes anything, leaving only `applyStatus`'s own patch to observe.
    const { service, limits } = seed({
      subscriptions: [],
      provider_subscriptions: payingAccount().provider_subscriptions,
      subscription_items: [],
    });

    await service.handleEvent('subscription.canceled', subEvent('canceled'));

    // Proof the sweep really did not run.
    expect(limits.applyLimitsToAllWorkspaces).not.toHaveBeenCalled();
    // ...so this is `applyStatus`'s write and nothing else.
    expect(providerRows()[0].isDefault).toBe(false);
    expect(isLive(providerRows()[0] as never)).toBe(false);
  });

  it('drops the account to FREE and clears scheduled changes', async () => {
    const { service } = seed({
      subscriptions: [
        {
          id: 42,
          userId: 'user-1',
          planCode: 'PRO',
          status: 'active',
          cancelAtPeriodEnd: true,
          scheduledPlanCode: 'BASIC',
          scheduledChangeAt: new Date('2026-12-01T00:00:00Z'),
        },
      ],
      provider_subscriptions: payingAccount().provider_subscriptions,
      subscription_items: [],
    });

    await service.handleEvent('subscription.canceled', subEvent('canceled'));

    expect(subRow()).toMatchObject({
      planCode: 'FREE',
      status: 'canceled',
      cancelAtPeriodEnd: false,
      scheduledPlanCode: null,
      scheduledChangeAt: null,
    });
    expect(subRow().canceledAt).toBeInstanceOf(Date);
  });

  it('resets the workspace limits to FREE', async () => {
    // Without this the account keeps its paid limits forever while Paddle
    // bills nothing.
    const { service, limits } = seed(payingAccount());
    await service.handleEvent('subscription.canceled', subEvent('canceled'));
    expect(limits.applyLimitsToAllWorkspaces).toHaveBeenCalledWith(
      'user-1',
      'FREE',
      {
        extraChannels: 0,
        extraMembers: 0,
        extraWorkspaces: 0,
        extraAiTokens: 0,
      },
    );
  });

  it('deletes the add-on bookkeeping rows', async () => {
    // `subscription_items` is what the app reads for quantities; leaving them
    // keeps granting capacity nobody pays for.
    const { service } = seed({
      ...payingAccount(),
      subscription_items: [
        { id: 1, subscriptionId: 42, itemType: 'EXTRA_CHANNEL', quantity: 3 },
      ],
    });

    await service.handleEvent('subscription.canceled', subEvent('canceled'));

    expect(store.rowsOf('subscription_items')).toHaveLength(0);
  });

  it('does NOT revive a row that is already terminal', async () => {
    // Ordering is not guaranteed. A late `active` that overtook a `canceled`
    // would otherwise restore the customer's limits and re-claim the
    // `is_default` slot a fresh signup elsewhere may already hold.
    const { service, limits } = seed(
      payingAccount({ providerStatus: 'canceled', isDefault: false }),
    );

    await service.handleEvent('subscription.updated', subEvent('active'));

    expect(providerRows()[0].providerStatus).toBe('canceled');
    expect(providerRows()[0].isDefault).toBe(false);
    expect(subRow().status).toBe('active');
    expect(limits.applyLimitsToAllWorkspaces).not.toHaveBeenCalled();
  });

  it('leaves another provider’s live row alone', async () => {
    // A cutover account can hold live rows elsewhere. A Paddle plan lapsing
    // after the customer moved must not touch the provider now charging them.
    const { service } = seed({
      subscriptions: [
        { id: 42, userId: 'user-1', planCode: 'PRO', status: 'active' },
      ],
      provider_subscriptions: [
        ...payingAccount({ isDefault: false }).provider_subscriptions,
        {
          id: 9,
          subscriptionId: 42,
          provider: 'stripe',
          itemType: 'BASE_PLAN',
          providerSubscriptionId: 'sub_stripe',
          providerStatus: 'active',
          isDefault: true,
        },
      ],
      subscription_items: [],
    });

    await service.handleEvent('subscription.canceled', subEvent('canceled'));

    const stripeRow = providerRows().find((r) => r.provider === 'stripe');
    expect(stripeRow?.providerStatus).toBe('active');
    expect(stripeRow?.isDefault).toBe(true);
  });
});

describe('PaddleWebhookService: add-ons', () => {
  it('revokes an add-on whose price left the items array', async () => {
    // An add-on is a LINE here, not a subscription, so Paddle fires no event
    // of its own when one goes — it arrives as an `updated` with a shorter
    // items array. Without this the entitlement survives unpaid.
    const { service, limits } = seed({
      subscriptions: [
        { id: 42, userId: 'user-1', planCode: 'PRO', status: 'active' },
      ],
      provider_subscriptions: [
        ...payingAccount().provider_subscriptions,
        {
          id: 2,
          subscriptionId: 42,
          provider: 'paddle',
          itemType: 'EXTRA_CHANNEL',
          providerSubscriptionId: PADDLE_SUB,
          providerPriceId: PRICE_CHANNEL,
          providerQuantity: 3,
          providerStatus: 'active',
          isDefault: false,
        },
      ],
      subscription_items: [
        { id: 1, subscriptionId: 42, itemType: 'EXTRA_CHANNEL', quantity: 3 },
      ],
    });

    // The base plan only — the channel line is gone.
    await service.handleEvent('subscription.updated', subEvent('active'));

    const addon = providerRows().find((r) => r.itemType === 'EXTRA_CHANNEL');
    expect(addon?.providerStatus).toBe('canceled');
    expect(store.rowsOf('subscription_items')).toHaveLength(0);
    expect(limits.applyLimitsToAllWorkspaces).toHaveBeenCalled();
  });

  it('keeps an add-on that is still on the subscription', async () => {
    const { service, limits } = seed({
      subscriptions: [
        { id: 42, userId: 'user-1', planCode: 'PRO', status: 'active' },
      ],
      provider_subscriptions: [
        ...payingAccount().provider_subscriptions,
        {
          id: 2,
          subscriptionId: 42,
          provider: 'paddle',
          itemType: 'EXTRA_CHANNEL',
          providerSubscriptionId: PADDLE_SUB,
          providerPriceId: PRICE_CHANNEL,
          providerQuantity: 3,
          providerStatus: 'active',
          isDefault: false,
        },
      ],
      subscription_items: [
        { id: 1, subscriptionId: 42, itemType: 'EXTRA_CHANNEL', quantity: 3 },
      ],
    });

    await service.handleEvent(
      'subscription.updated',
      subEvent('active', {
        items: [
          { priceId: PRICE_BASE, quantity: 1 },
          { priceId: PRICE_CHANNEL, quantity: 3 },
        ],
      }),
    );

    expect(
      providerRows().find((r) => r.itemType === 'EXTRA_CHANNEL')
        ?.providerStatus,
    ).toBe('active');
    expect(store.rowsOf('subscription_items')).toHaveLength(1);
    expect(limits.applyLimitsToAllWorkspaces).not.toHaveBeenCalled();
  });

  it('revokes nothing when the event carries no items at all', async () => {
    // An items array we did not receive must not be read as "every add-on is
    // gone" — that would strip every paid extra on a malformed delivery.
    const { service, limits } = seed({
      subscriptions: [
        { id: 42, userId: 'user-1', planCode: 'PRO', status: 'active' },
      ],
      provider_subscriptions: [
        ...payingAccount().provider_subscriptions,
        {
          id: 2,
          subscriptionId: 42,
          provider: 'paddle',
          itemType: 'EXTRA_CHANNEL',
          providerSubscriptionId: PADDLE_SUB,
          providerPriceId: PRICE_CHANNEL,
          providerStatus: 'active',
          isDefault: false,
        },
      ],
      subscription_items: [
        { id: 1, subscriptionId: 42, itemType: 'EXTRA_CHANNEL', quantity: 3 },
      ],
    });

    await service.handleEvent('subscription.updated', {
      data: { id: PADDLE_SUB, status: 'active', items: [] },
    });

    expect(
      providerRows().find((r) => r.itemType === 'EXTRA_CHANNEL')
        ?.providerStatus,
    ).toBe('active');
    expect(limits.applyLimitsToAllWorkspaces).not.toHaveBeenCalled();
  });

  it('never revokes the BASE_PLAN row as though it were an add-on', async () => {
    // The base plan's price changes on an upgrade, so it would look "missing"
    // to a naive comparison — and revoking it would drop a paying account to
    // FREE on a plan change.
    const { service } = seed(payingAccount());

    await service.handleEvent(
      'subscription.updated',
      subEvent('active', { items: [{ priceId: 'pri_base_max', quantity: 1 }] }),
    );

    expect(providerRows()[0].providerStatus).toBe('active');
    expect(subRow().planCode).toBe('PRO');
  });

  it('leaves an add-on row with no recorded price alone', async () => {
    // It cannot be matched against the items, and guessing would revoke a
    // paid add-on.
    const { service } = seed({
      subscriptions: [
        { id: 42, userId: 'user-1', planCode: 'PRO', status: 'active' },
      ],
      provider_subscriptions: [
        ...payingAccount().provider_subscriptions,
        {
          id: 2,
          subscriptionId: 42,
          provider: 'paddle',
          itemType: 'EXTRA_MEMBER',
          providerSubscriptionId: PADDLE_SUB,
          providerPriceId: null,
          providerStatus: 'active',
          isDefault: false,
        },
      ],
      subscription_items: [],
    });

    await service.handleEvent('subscription.updated', subEvent('active'));

    expect(
      providerRows().find((r) => r.itemType === 'EXTRA_MEMBER')?.providerStatus,
    ).toBe('active');
  });
});

describe('PaddleWebhookService: transactions', () => {
  it('reads the subscription from subscription_id, not data.id', async () => {
    // `data.id` on a transaction event is the TRANSACTION's id. Looking that
    // up in the subscription column silently matches nothing.
    const { service, alerts } = seed(payingAccount());

    await service.handleEvent('transaction.payment_failed', {
      data: {
        id: 'txn_1',
        subscription_id: PADDLE_SUB,
        status: 'past_due',
        created_at: '2026-11-25T00:00:00Z',
        details: { totals: { grand_total: '2900' } },
      },
    });

    expect(subRow().status).toBe('past_due');
    expect(alerts.paymentFailed).toHaveBeenCalled();
  });

  it('sends the payment-failed EMAIL, not only the in-app alert', async () => {
    // The alert and the email are different channels with different rules.
    // `payment-alerts.service` states it: "The payment-failed EMAIL is
    // mandatory and sent by the webhooks, not here." The alert rings a bell
    // and raises a toast, both conditional on the user's `billing_alert`
    // preference; the email is not, because a customer whose card declined
    // has to find out while they are NOT logged in — the normal case during a
    // dunning retry window.
    //
    // Paddle sent only the alert. A customer could have their card fail,
    // Paddle could exhaust its retries, and the subscription could end with
    // the account dropping to FREE having been told nothing. Stripe and Lemon
    // Squeezy both send it.
    const { service, emails } = seed(payingAccount());

    await service.handleEvent('transaction.payment_failed', {
      data: {
        id: 'txn_1',
        subscription_id: PADDLE_SUB,
        status: 'past_due',
        created_at: '2026-11-25T00:00:00Z',
        details: { totals: { grand_total: '2900' } },
      },
    });

    expect(emails.paymentFailed).toHaveBeenCalledTimes(1);
    expect(emails.paymentFailed.mock.calls[0][0]).toMatchObject({
      userId: 'user-1',
      amountCents: 2900,
    });
  });

  it('does not email on a SUCCESSFUL payment', async () => {
    // The success path has its own alert and must not raise a failure notice.
    const { service, emails } = seed(payingAccount());

    await service.handleEvent('transaction.completed', {
      data: {
        id: 'txn_1',
        subscription_id: PADDLE_SUB,
        status: 'completed',
        created_at: '2026-11-25T00:00:00Z',
        details: { totals: { grand_total: '2900' } },
      },
    });

    expect(emails.paymentFailed).not.toHaveBeenCalled();
  });

  it('still answers when the email throws', async () => {
    // A failed send must not 500 the webhook: Paddle would retry an event
    // already applied, and the billing writes above it are already done.
    const { service, emails } = seed(payingAccount());
    emails.paymentFailed.mockRejectedValue(new Error('resend down'));

    await expect(
      service.handleEvent('transaction.payment_failed', {
        data: {
          id: 'txn_1',
          subscription_id: PADDLE_SUB,
          status: 'past_due',
          created_at: '2026-11-25T00:00:00Z',
          details: { totals: { grand_total: '2900' } },
        },
      }),
    ).resolves.toBeUndefined();

    expect(subRow().status).toBe('past_due');
  });

  it('passes the amount in minor units as a NUMBER', async () => {
    // Paddle sends money as a string of minor units. Passing "2900" through
    // would print as a dollar amount a hundred times too large.
    const { service, alerts } = seed(payingAccount());

    await service.handleEvent('transaction.payment_failed', {
      data: {
        id: 'txn_1',
        subscription_id: PADDLE_SUB,
        details: { totals: { grand_total: '2900' } },
      },
    });

    expect(alerts.paymentFailed).toHaveBeenCalledWith(
      expect.objectContaining({ amountMinor: 2900 }),
    );
  });

  it('keys the alert on the transaction, so a redelivery alerts once', async () => {
    const { service, alerts } = seed(payingAccount());
    await service.handleEvent('transaction.payment_failed', {
      data: { id: 'txn_7', subscription_id: PADDLE_SUB },
    });
    expect(alerts.paymentFailed).toHaveBeenCalledWith(
      expect.objectContaining({ alertKey: 'paddle:failed:txn_7' }),
    );
  });

  it('recovers the account and reports it was past due', async () => {
    // `wasPastDue` is the recovery alert's evidence there was something to
    // recover from, and it must be read BEFORE the write that clears it.
    const { service, alerts } = seed({
      subscriptions: [
        { id: 42, userId: 'user-1', planCode: 'PRO', status: 'past_due' },
      ],
      provider_subscriptions: payingAccount().provider_subscriptions,
      subscription_items: [],
    });

    await service.handleEvent('transaction.completed', {
      data: { id: 'txn_2', subscription_id: PADDLE_SUB },
    });

    expect(subRow().status).toBe('active');
    expect(alerts.paymentSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({ wasPastDue: true, planCode: 'PRO' }),
    );
  });

  it('ignores a transaction with no subscription', async () => {
    const { service, alerts } = seed(payingAccount());
    await service.handleEvent('transaction.completed', {
      data: { id: 'txn_3', subscription_id: null },
    });
    expect(alerts.paymentSucceeded).not.toHaveBeenCalled();
    expect(subRow().status).toBe('active');
  });

  it('does not write the provider row status from a payment event', async () => {
    // Payment events carry no subscription status; `subscription.updated`
    // follows and is the authority. Writing one here would fight it.
    const { service } = seed(payingAccount());
    await service.handleEvent('transaction.payment_failed', {
      data: { id: 'txn_4', subscription_id: PADDLE_SUB },
    });
    expect(providerRows()[0].providerStatus).toBe('active');
  });

  it('still answers when the alert throws', async () => {
    // A 500 here is a Paddle retry of an event already applied.
    const { service, alerts } = seed(payingAccount());
    alerts.paymentFailed.mockRejectedValue(new Error('smtp down'));

    await expect(
      service.handleEvent('transaction.payment_failed', {
        data: { id: 'txn_5', subscription_id: PADDLE_SUB },
      }),
    ).resolves.toBeUndefined();

    expect(subRow().status).toBe('past_due');
  });
});

describe('PaddleWebhookService: unknown events', () => {
  it('ignores an event it does not handle, without throwing', async () => {
    const { service } = seed(payingAccount());
    await expect(
      service.handleEvent('customer.updated', { data: { id: 'ctm_1' } }),
    ).resolves.toBeUndefined();
    expect(providerRows()[0].providerStatus).toBe('active');
  });

  it('ignores a subscription event with no id', async () => {
    const { service } = seed(payingAccount());
    await expect(
      service.handleEvent('subscription.updated', { data: {} }),
    ).resolves.toBeUndefined();
    expect(providerRows()[0].providerStatus).toBe('active');
  });

  it('survives an empty payload', async () => {
    const { service } = seed(payingAccount());
    await expect(
      service.handleEvent('subscription.updated', undefined),
    ).resolves.toBeUndefined();
  });
});
