/**
 * PaymentAlertsService decides WHETHER the billing owner hears about a payment
 * and sends it down both channels: the notification row (the bell) and the
 * `billing.payment.changed` event on `/realtime` (the toast).
 *
 * "Already alerted?" lives in `billing_payment_alerts`, claimed with
 * INSERT … ON CONFLICT (alert_key) DO NOTHING RETURNING. The fake below keeps
 * that table for real: an insert whose key exists returns no row, exactly as
 * Postgres does, and the conflict target is read off the real drizzle column
 * so dropping it from the service fails these tests. The SQL itself is proven
 * on local Postgres (see the report for the BEGIN … ROLLBACK script).
 */

/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

interface AlertRow {
  id: number;
  userId: string;
  alertKey: string;
  kind: 'failed' | 'recovered';
  provider: string;
  createdAt: Date;
}

let alertsTable: AlertRow[];
let plansTable: { code: string; name: string }[];
let clock = 0;

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
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      then: (resolve: (v: unknown) => unknown) => {
        if (table === 'billing_payment_alerts') {
          // Newest first, as `ORDER BY created_at DESC, id DESC` returns it.
          const rows = [...alertsTable].sort(
            (a, b) =>
              b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id,
          );
          return Promise.resolve(rows).then(resolve);
        }
        if (table === 'plans') return Promise.resolve(plansTable).then(resolve);
        return Promise.resolve([]).then(resolve);
      },
    };
    return chain;
  },
  insert: (t: unknown) => {
    if (tableName(t) !== 'billing_payment_alerts') {
      throw new Error(`unexpected insert into ${tableName(t)}`);
    }
    let row: Omit<AlertRow, 'id' | 'createdAt'>;
    let conflictTarget: unknown = null;
    const chain: any = {
      values: (v: Omit<AlertRow, 'id' | 'createdAt'>) => {
        row = v;
        return chain;
      },
      onConflictDoNothing: (arg: { target: { name?: string } }) => {
        conflictTarget = arg?.target?.name;
        return chain;
      },
      returning: () => {
        if (conflictTarget !== 'alert_key') {
          throw new Error('the claim must conflict on alert_key');
        }
        if (alertsTable.some((r) => r.alertKey === row.alertKey)) {
          return Promise.resolve([]);
        }
        const stored: AlertRow = {
          ...row,
          id: alertsTable.length + 1,
          createdAt: new Date(++clock * 1000),
        };
        alertsTable.push(stored);
        return Promise.resolve([{ id: stored.id }]);
      },
    };
    return chain;
  },
  delete: () => ({
    where: (c: unknown) => {
      const id = boundValues(c).find((v) => typeof v === 'number');
      alertsTable = alertsTable.filter((r) => r.id !== id);
      return Promise.resolve([]);
    },
  }),
};
jest.mock('../../drizzle/db', () => ({ db: mockDb }));

import {
  NO_WORKSPACE_BILLING_URL,
  PaymentAlertsService,
  toCard,
} from './payment-alerts.service';

/** Every bound value inside a drizzle condition. */
function boundValues(node: unknown, out: unknown[] = []): unknown[] {
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
const prefs = { shouldSend: jest.fn() };

function make(): PaymentAlertsService {
  return new PaymentAlertsService(
    notifier as never,
    realtime as never,
    lookup as never,
    paymentMethods as never,
    prefs as never,
  );
}

const FAILED = {
  userId: USER,
  provider: 'stripe' as const,
  alertKey: 'stripe:failed:evt_1',
  amountMinor: 2900,
  card: null,
  reason: null,
};

const SUCCEEDED = {
  userId: USER,
  provider: 'stripe' as const,
  alertKey: 'stripe:recovered:in_1',
  amountMinor: 2900,
  planCode: 'PRO',
  wasPastDue: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  alertsTable = [];
  plansTable = [];
  clock = 0;
  lookup.getPrimaryWorkspaceId.mockResolvedValue(WS);
  paymentMethods.getDefaultPaymentMethod.mockResolvedValue({
    brand: 'visa',
    last4: '4242',
  });
  prefs.shouldSend.mockResolvedValue(true);
});

describe('paymentFailed and the billing_alert in-app preference', () => {
  it('asks the owner’s in-app billing_alert switch for the workspace the bell links to', async () => {
    await expect(make().paymentFailed(FAILED)).resolves.toBe(true);
    expect(prefs.shouldSend).toHaveBeenCalledWith(
      USER,
      WS,
      'billing_alert',
      'app',
    );
    expect(notifier.paymentFailed).toHaveBeenCalledTimes(1);
    expect(realtime.emitToUser).toHaveBeenCalledTimes(1);
  });

  it('switched off: no bell and no toast, and the failure is still recorded', async () => {
    prefs.shouldSend.mockResolvedValue(false);
    await expect(make().paymentFailed(FAILED)).resolves.toBe(false);
    expect(notifier.paymentFailed).not.toHaveBeenCalled();
    expect(realtime.emitToUser).not.toHaveBeenCalled();
    // Kept, so a redelivery stays quiet and a later recovery is recognised.
    expect(alertsTable).toEqual([
      expect.objectContaining({ alertKey: FAILED.alertKey, kind: 'failed' }),
    ]);
  });

  it('an owner with no workspace is asked at account level', async () => {
    lookup.getPrimaryWorkspaceId.mockResolvedValue(null);
    await make().paymentFailed(FAILED);
    expect(prefs.shouldSend).toHaveBeenCalledWith(
      USER,
      null,
      'billing_alert',
      'app',
    );
  });
});

describe('paymentFailed', () => {
  it('notifies the owner with a workspace billing link and the saved card', async () => {
    await expect(make().paymentFailed(FAILED)).resolves.toBe(true);

    expect(notifier.paymentFailed).toHaveBeenCalledWith(USER, 29, undefined, {
      actionUrl: `/w/${WS}/settings/billing`,
      metadata: {
        alertKey: 'stripe:failed:evt_1',
        provider: 'stripe',
        workspaceId: WS,
        card: { brand: 'visa', last4: '4242' },
      },
    });
    expect(alertsTable).toEqual([
      expect.objectContaining({
        userId: USER,
        alertKey: 'stripe:failed:evt_1',
        kind: 'failed',
        provider: 'stripe',
      }),
    ]);
  });

  it('strips a trailing full stop from a provider reason (the emitter adds one)', async () => {
    await make().paymentFailed({ ...FAILED, reason: 'Card declined.' });

    expect(notifier.paymentFailed).toHaveBeenCalledWith(
      USER,
      29,
      'Card declined',
      expect.anything(),
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

  it('alerts once per key, even when two deliveries race', async () => {
    const service = make();
    const results = await Promise.all([
      service.paymentFailed(FAILED),
      service.paymentFailed(FAILED),
    ]);

    expect(results.sort()).toEqual([false, true]);
    expect(notifier.paymentFailed).toHaveBeenCalledTimes(1);
    expect(realtime.emitToUser).toHaveBeenCalledTimes(1);
  });

  it('does not depend on notification rows: "clear all" never re-arms an alert', async () => {
    await make().paymentFailed(FAILED);
    // The user deletes every notification; the claim is billing data.
    await expect(make().paymentFailed(FAILED)).resolves.toBe(false);
    expect(notifier.paymentFailed).toHaveBeenCalledTimes(1);
  });

  it('a send that fails gives the key back, so a later delivery can alert', async () => {
    notifier.paymentFailed.mockRejectedValueOnce(new Error('db down'));

    await expect(make().paymentFailed(FAILED)).resolves.toBe(false);
    expect(alertsTable).toHaveLength(0);

    await expect(make().paymentFailed(FAILED)).resolves.toBe(true);
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

  it('an owner with no workspace is sent to their own hub, never into another workspace', async () => {
    lookup.getPrimaryWorkspaceId.mockResolvedValue(null);

    await make().paymentFailed(FAILED);

    expect(notifier.paymentFailed).toHaveBeenCalledWith(
      USER,
      29,
      undefined,
      expect.objectContaining({ actionUrl: NO_WORKSPACE_BILLING_URL }),
    );
    expect(NO_WORKSPACE_BILLING_URL).toBe('/workspaces');
    expect(realtime.emitToUser).toHaveBeenCalledWith(
      USER,
      'billing.payment.changed',
      expect.objectContaining({ workspaceId: null }),
    );
  });
});

describe('paymentSucceeded', () => {
  it('announces a recovery the caller saw (was past_due)', async () => {
    plansTable = [{ code: 'PRO', name: 'Pro' }];

    await expect(make().paymentSucceeded(SUCCEEDED)).resolves.toBe(true);

    expect(notifier.paymentSuccessful).toHaveBeenCalledWith(USER, 29, 'Pro', {
      actionUrl: `/w/${WS}/settings/billing`,
      metadata: {
        kind: 'payment_recovered',
        alertKey: 'stripe:recovered:in_1',
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
    await make().paymentFailed(FAILED);

    await expect(
      make().paymentSucceeded({ ...SUCCEEDED, wasPastDue: false }),
    ).resolves.toBe(true);
    expect(notifier.paymentSuccessful).toHaveBeenCalledTimes(1);
  });

  it('stays silent on an ordinary renewal', async () => {
    await expect(
      make().paymentSucceeded({ ...SUCCEEDED, wasPastDue: false }),
    ).resolves.toBe(false);
    expect(notifier.paymentSuccessful).not.toHaveBeenCalled();
    expect(realtime.emitToUser).not.toHaveBeenCalled();
  });

  it('stays silent on a renewal after an earlier, already announced recovery', async () => {
    await make().paymentFailed(FAILED);
    await make().paymentSucceeded(SUCCEEDED);
    jest.clearAllMocks();

    await expect(
      make().paymentSucceeded({
        ...SUCCEEDED,
        alertKey: 'stripe:recovered:in_2',
        wasPastDue: false,
      }),
    ).resolves.toBe(false);
    expect(realtime.emitToUser).not.toHaveBeenCalled();
  });

  it('the success/recovered pair for one invoice announces ONCE, even concurrently', async () => {
    await make().paymentFailed(FAILED);
    jest.clearAllMocks();
    const service = make();

    const results = await Promise.all([
      service.paymentSucceeded({ ...SUCCEEDED, wasPastDue: true }),
      service.paymentSucceeded({ ...SUCCEEDED, wasPastDue: false }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(notifier.paymentSuccessful).toHaveBeenCalledTimes(1);
    expect(realtime.emitToUser).toHaveBeenCalledTimes(1);
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

  it('never throws: a failing notifier must not fail the webhook', async () => {
    notifier.paymentSuccessful.mockRejectedValueOnce(new Error('db down'));

    await expect(make().paymentSucceeded(SUCCEEDED)).resolves.toBe(false);
    expect(alertsTable).toHaveLength(0);
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
