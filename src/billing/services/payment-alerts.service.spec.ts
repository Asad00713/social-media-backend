/**
 * PaymentAlertsService decides WHETHER the billing owner hears about a payment
 * and sends it down both channels: the notification row (the bell) and the
 * `billing.payment.changed` event on `/realtime` (the toast).
 *
 * The db is faked per table: each test states what the `notifications` and
 * `plans` tables answer. Where clauses are captured so the dedupe test can
 * prove the key it was given is the key it looked up.
 */

/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

type Rows = Record<string, unknown>[];

let answers: Record<string, Rows>;
const wheres: { table: string; condition: unknown }[] = [];

function tableName(t: unknown): string {
  const sym = Object.getOwnPropertySymbols(t as object).find((s) =>
    String(s).includes('Name'),
  );
  return sym ? String((t as any)[sym]) : 'unknown';
}

const mockDb = {
  select: () => {
    let table = 'unknown';
    const chain: any = {
      from: (t: unknown) => {
        table = tableName(t);
        return chain;
      },
      where: (c: unknown) => {
        wheres.push({ table, condition: c });
        return chain;
      },
      orderBy: () => chain,
      limit: () => chain,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(answers[table] ?? []).then(resolve),
    };
    return chain;
  },
};
jest.mock('../../drizzle/db', () => ({ db: mockDb }));

import { PaymentAlertsService, toCard } from './payment-alerts.service';

/** Every bound value inside a drizzle condition, however deeply nested. */
function boundValues(node: unknown, out: unknown[] = []): unknown[] {
  // A primitive interpolated into a raw sql`` template sits in queryChunks
  // as itself; drizzle binds it as a parameter.
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(node);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  const chunks = (node as any).queryChunks as unknown[] | undefined;
  if (Array.isArray(chunks)) {
    for (const c of chunks) boundValues(c, out);
    return out;
  }
  if ('value' in (node as any) && !Array.isArray((node as any).value)) {
    out.push((node as any).value);
  }
  return out;
}

const USER = 'user-1';
const WS = 'ws-primary';

const notifier = {
  paymentFailed: jest.fn().mockResolvedValue({ id: 'n1' }),
  paymentSuccessful: jest.fn().mockResolvedValue({ id: 'n2' }),
};
const realtime = { emitToUser: jest.fn() };
const lookup = { getPrimaryWorkspaceId: jest.fn() };
const paymentMethods = { getDefaultPaymentMethod: jest.fn() };

function make(): PaymentAlertsService {
  return new PaymentAlertsService(
    notifier as never,
    realtime as never,
    lookup as never,
    paymentMethods as never,
  );
}

const FAILED = {
  userId: USER,
  provider: 'stripe' as const,
  dedupeKey: 'stripe:in_1:1',
  amountMinor: 2900,
  card: null,
  reason: 'Your card was declined.',
};

beforeEach(() => {
  jest.clearAllMocks();
  wheres.length = 0;
  answers = {};
  lookup.getPrimaryWorkspaceId.mockResolvedValue(WS);
  paymentMethods.getDefaultPaymentMethod.mockResolvedValue({
    brand: 'visa',
    last4: '4242',
  });
});

describe('paymentFailed', () => {
  it('notifies the owner with a workspace billing link and the saved card', async () => {
    await expect(make().paymentFailed(FAILED)).resolves.toBe(true);

    expect(notifier.paymentFailed).toHaveBeenCalledWith(
      USER,
      29,
      // The emitter adds its own full stop; the reason's would double it.
      'Your card was declined',
      {
        actionUrl: `/w/${WS}/settings/billing`,
        metadata: {
          dedupeKey: 'stripe:in_1:1',
          provider: 'stripe',
          workspaceId: WS,
          card: { brand: 'visa', last4: '4242' },
        },
      },
    );
  });

  it('sends the live event to the owner only, with the card', async () => {
    await make().paymentFailed(FAILED);

    expect(realtime.emitToUser).toHaveBeenCalledTimes(1);
    expect(realtime.emitToUser).toHaveBeenCalledWith(
      USER,
      'billing.payment.changed',
      expect.objectContaining({
        state: 'failed',
        provider: 'stripe',
        workspaceId: WS,
        card: { brand: 'visa', last4: '4242' },
      }),
    );
  });

  it('is silent when that attempt was already notified (webhook redelivery)', async () => {
    answers.notifications = [{ id: 'n0' }];

    await expect(make().paymentFailed(FAILED)).resolves.toBe(false);

    expect(notifier.paymentFailed).not.toHaveBeenCalled();
    expect(realtime.emitToUser).not.toHaveBeenCalled();
    // The lookup was for THIS key, this user, this type.
    const lookupClause = wheres.find((w) => w.table === 'notifications');
    const values = boundValues(lookupClause?.condition);
    expect(values).toEqual(
      expect.arrayContaining([USER, 'payment_failed', 'stripe:in_1:1']),
    );
  });

  it('uses the card the webhook named instead of the saved one', async () => {
    await make().paymentFailed({
      ...FAILED,
      provider: 'lemonsqueezy',
      card: { brand: 'mastercard', last4: '5555' },
    });

    expect(paymentMethods.getDefaultPaymentMethod).not.toHaveBeenCalled();
    expect(realtime.emitToUser).toHaveBeenCalledWith(
      USER,
      'billing.payment.changed',
      expect.objectContaining({ card: { brand: 'mastercard', last4: '5555' } }),
    );
  });

  it('sends card null when no card is known', async () => {
    paymentMethods.getDefaultPaymentMethod.mockResolvedValue(null);

    await make().paymentFailed(FAILED);

    expect(realtime.emitToUser).toHaveBeenCalledWith(
      USER,
      'billing.payment.changed',
      expect.objectContaining({ card: null }),
    );
  });

  it('never throws: a failing notifier must not fail the webhook', async () => {
    notifier.paymentFailed.mockRejectedValueOnce(new Error('db down'));

    await expect(make().paymentFailed(FAILED)).resolves.toBe(false);
  });
});

describe('paymentSucceeded', () => {
  const SUCCEEDED = {
    userId: USER,
    provider: 'stripe' as const,
    amountMinor: 2900,
    planCode: 'PRO',
    wasPastDue: true,
  };

  it('announces a recovery the caller saw (was past_due)', async () => {
    answers.plans = [{ name: 'Pro' }];

    await expect(make().paymentSucceeded(SUCCEEDED)).resolves.toBe(true);

    expect(notifier.paymentSuccessful).toHaveBeenCalledWith(USER, 29, 'Pro', {
      actionUrl: `/w/${WS}/settings/billing`,
      metadata: {
        kind: 'payment_recovered',
        provider: 'stripe',
        workspaceId: WS,
      },
    });
    expect(realtime.emitToUser).toHaveBeenCalledWith(
      USER,
      'billing.payment.changed',
      expect.objectContaining({ state: 'recovered', card: null }),
    );
  });

  it('announces a recovery when the status already flipped but the last alert is a failure', async () => {
    // The provider's status event overtook the payment event.
    answers.notifications = [{ type: 'payment_failed' }];

    await expect(
      make().paymentSucceeded({ ...SUCCEEDED, wasPastDue: false }),
    ).resolves.toBe(true);
    expect(realtime.emitToUser).toHaveBeenCalledTimes(1);
  });

  it('stays silent on an ordinary renewal', async () => {
    answers.notifications = [];

    await expect(
      make().paymentSucceeded({ ...SUCCEEDED, wasPastDue: false }),
    ).resolves.toBe(false);
    expect(notifier.paymentSuccessful).not.toHaveBeenCalled();
    expect(realtime.emitToUser).not.toHaveBeenCalled();
  });

  it('stays silent on a redelivered recovery (the last alert is the recovery)', async () => {
    answers.notifications = [{ type: 'payment_successful' }];

    await expect(
      make().paymentSucceeded({ ...SUCCEEDED, wasPastDue: false }),
    ).resolves.toBe(false);
    expect(realtime.emitToUser).not.toHaveBeenCalled();
  });

  it('falls back to the plan code when the plan row is missing', async () => {
    await make().paymentSucceeded(SUCCEEDED);

    expect(notifier.paymentSuccessful).toHaveBeenCalledWith(
      USER,
      29,
      'PRO',
      expect.anything(),
    );
  });
});

describe('toCard', () => {
  it('lowercases the brand', () => {
    expect(toCard('Visa', '4242')).toEqual({ brand: 'visa', last4: '4242' });
  });
  it('names nothing from half a card', () => {
    expect(toCard('visa', null)).toBeNull();
    expect(toCard(null, '4242')).toBeNull();
    expect(toCard('visa', '42')).toBeNull();
  });
});
