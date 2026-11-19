/**
 * The Stripe webhook tells the billing owner about a failed payment, and about
 * the payment that ends the failure.
 *
 * What is pinned here is the WEBHOOK's half: which user, which dedupe key,
 * and whether the success it saw ended dunning. The decision to stay silent on
 * a duplicate key or an ordinary renewal lives in `PaymentAlertsService` and
 * is pinned in its own spec.
 *
 * The db fake is table-keyed and interprets `eq` / `gt` / `and`, so a write is
 * visible to a later select: "were there unresolved failures BEFORE the
 * resolve" can only be answered correctly if the read really precedes it.
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
type Predicate = (row: Row) => boolean;

let tables: Record<string, Row[]>;

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

function camel(sqlName: string): string {
  return sqlName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function flatten(chunks: unknown[], out: unknown[] = []): unknown[] {
  for (const chunk of chunks) {
    const nested = (chunk as any)?.queryChunks as unknown[] | undefined;
    if (Array.isArray(nested)) flatten(nested, out);
    else out.push(chunk);
  }
  return out;
}

function isColumn(chunk: unknown): boolean {
  return (
    !!chunk &&
    typeof chunk === 'object' &&
    typeof (chunk as any).name === 'string'
  );
}

/** `=` and `>` only; anything else throws rather than matching everything. */
function predicateFrom(condition: unknown): Predicate {
  if (!condition) return () => true;
  const chunks = flatten((condition as any).queryChunks as unknown[]);
  const tests: Predicate[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk: any = chunks[i];
    if (!isColumn(chunk)) continue;
    const op = chunks[i + 1] as any;
    const opText = Array.isArray(op?.value) ? String(op.value[0]) : '';
    const param = chunks[i + 2] as any;
    const value =
      param && typeof param === 'object' && 'value' in param
        ? param.value
        : param;
    const column = camel(chunk.name);
    if (opText.includes('>')) {
      tests.push((r) => (r[column] as Date) > (value as Date));
    } else if (opText.includes('=')) {
      tests.push((r) => r[column] === value);
    } else {
      throw new Error(`The db fake does not understand "${opText}".`);
    }
    i += 2;
  }
  if (tests.length === 0) throw new Error('The db fake understood nothing.');
  return (row) => tests.every((t) => t(row));
}

function makeDb(): any {
  return {
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
        orderBy: () => chain,
        limit: () => chain,
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(rowsOf(target).filter(match)).then(resolve),
      };
      return chain;
    },
    insert: (t: unknown) => {
      const target = tableName(t);
      let pending: Row = {};
      /**
       * `billing_events.stripe_event_id` is UNIQUE, and the webhook's dedup
       * gate IS that constraint now: it inserts with ON CONFLICT DO NOTHING
       * and reads `returning()` to learn whether it won the claim.
       *
       * So this fake has to ENFORCE the constraint. Pushing unconditionally —
       * what it did — hands the gate a row back every time, and the redelivery
       * test below would then pass even if the gate let both deliveries
       * through: the fake agreeing with a broken implementation.
       */
      const run = (): Row[] => {
        if (target === 'billing_events') {
          const id = pending.stripeEventId;
          if (rowsOf(target).some((r) => r.stripeEventId === id)) return [];
        }
        const row = {
          id: rowsOf(target).length + 1,
          resolved: false,
          createdAt: new Date(),
          ...pending,
        };
        rowsOf(target).push(row);
        return [row];
      };
      const chain: any = {
        values: (v: Row) => {
          pending = v;
          return chain;
        },
        onConflictDoNothing: () => chain,
        returning: () => Promise.resolve(run().map((r) => ({ id: r.id }))),
        then: (resolve: (v: unknown) => unknown) => {
          run();
          return Promise.resolve([]).then(resolve);
        },
      };
      return chain;
    },
    update: (t: unknown) => {
      const target = tableName(t);
      let patch: Row = {};
      const chain: any = {
        set: (v: Row) => {
          patch = v;
          return chain;
        },
        where: (c: unknown) => {
          const match = predicateFrom(c);
          for (const row of rowsOf(target)) {
            if (match(row)) Object.assign(row, patch);
          }
          return Promise.resolve([]);
        },
      };
      return chain;
    },
    /**
     * The webhook's failure path DELETEs its `billing_events` claim so that
     * Stripe's retry can reprocess the event.
     *
     * No test here drives a throwing handler today, so nothing reaches it -
     * but the release is wrapped in its own try/catch in production (correctly:
     * a failed release must not replace the handler's error). Without this
     * method a future failure test would get `db.delete is not a function`,
     * that TypeError would be SWALLOWED by that catch, and the test would look
     * like it passed while the release never happened.
     */
    delete: (t: unknown) => {
      const target = tableName(t);
      const chain: any = {
        where: (c: unknown) => {
          const match = predicateFrom(c);
          tables[target] = rowsOf(target).filter((row) => !match(row));
          return Promise.resolve([]);
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
  getInvoiceSubscriptionId: (inv: { subscription?: string }) =>
    inv.subscription ?? null,
}));

import { WebhookService } from './webhook.service';

const USER = 'user-1';

const alerts = {
  paymentFailed: jest.fn().mockResolvedValue(true),
  paymentSucceeded: jest.fn().mockResolvedValue(true),
};
const lookup = {
  getAddonQuantities: jest.fn().mockResolvedValue({}),
  applyLimitsToAllWorkspaces: jest.fn().mockResolvedValue(undefined),
};

function make(): WebhookService {
  return new WebhookService(
    {} as never,
    {} as never,
    lookup as never,
    // The templated payment-failed email is billing-email's (its own spec).
    {
      paymentFailed: jest.fn().mockResolvedValue(undefined),
      planName: jest.fn((code: string) => Promise.resolve(code)),
    } as never,
    alerts as never,
  );
}

function call(
  handler: string,
  payload: unknown,
  eventId?: string,
): Promise<void> {
  return (make() as any)[handler](payload, eventId) as Promise<void>;
}

/**
 * A Stripe Invoice as the API sends it. It has NO `last_payment_error` (that
 * lives on the PaymentIntent) — a fixture carrying one hid that the alert's
 * reason was always the placeholder "Payment failed".
 */
function failedInvoice(attempt: number): unknown {
  return {
    id: 'in_1',
    subscription: 'sub_1',
    attempt_count: attempt,
    amount_due: 2900,
  };
}

function failedEvent(id: string, attempt = 1): unknown {
  return {
    id,
    type: 'invoice.payment_failed',
    data: { object: failedInvoice(attempt) },
  };
}

const PAID_INVOICE = { id: 'in_1', subscription: 'sub_1', amount_paid: 2900 };

function account(): Row {
  return rowsOf('subscriptions')[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  tables = {
    subscriptions: [
      {
        id: 42,
        userId: USER,
        planCode: 'PRO',
        status: 'active',
        stripeSubscriptionId: 'sub_1',
      },
    ],
    invoices: [{ id: 7, stripeInvoiceId: 'in_1', subscriptionId: 42 }],
    failed_payments: [],
  };
});

describe('invoice.payment_failed', () => {
  it('alerts the billing owner, keyed on the EVENT, with no placeholder reason', async () => {
    await call('handleInvoicePaymentFailed', failedInvoice(2), 'evt_1');

    expect(alerts.paymentFailed).toHaveBeenCalledTimes(1);
    expect(alerts.paymentFailed).toHaveBeenCalledWith({
      userId: USER,
      provider: 'stripe',
      alertKey: 'stripe:failed:evt_1',
      amountMinor: 2900,
      card: null,
      // null lets the notification use its own sentence, not "failed: Payment failed."
      reason: null,
    });
    // The billing write the alert follows still happened.
    expect(account().status).toBe('past_due');
  });

  it('a manual retry that fails again alerts again (attempt_count does not move)', async () => {
    await make().handleWebhook(failedEvent('evt_1', 1) as never);
    await make().handleWebhook(failedEvent('evt_2', 1) as never);

    const keys = alerts.paymentFailed.mock.calls.map(
      (c: [{ alertKey: string }]) => c[0].alertKey,
    );
    expect(keys).toEqual(['stripe:failed:evt_1', 'stripe:failed:evt_2']);
  });

  it('a redelivered event alerts nothing (billing_events stops it first)', async () => {
    await make().handleWebhook(failedEvent('evt_1') as never);
    await make().handleWebhook(failedEvent('evt_1') as never);

    expect(alerts.paymentFailed).toHaveBeenCalledTimes(1);
  });

  it('does not alert for an invoice it cannot tie to a subscription', async () => {
    tables.invoices = [
      { id: 7, stripeInvoiceId: 'in_1', subscriptionId: null },
    ];

    await call('handleInvoicePaymentFailed', failedInvoice(1), 'evt_1');

    expect(alerts.paymentFailed).not.toHaveBeenCalled();
  });
});

describe('invoice.payment_succeeded', () => {
  it('reports dunning when the account was past_due', async () => {
    account().status = 'past_due';

    await call('handleInvoicePaymentSucceeded', PAID_INVOICE);

    expect(alerts.paymentSucceeded).toHaveBeenCalledWith({
      userId: USER,
      provider: 'stripe',
      alertKey: 'stripe:recovered:in_1',
      amountMinor: 2900,
      planCode: 'PRO',
      wasPastDue: true,
    });
    expect(account().status).toBe('active');
  });

  it('reads unresolved failures BEFORE resolving them (status already flipped)', async () => {
    // `customer.subscription.updated` overtook the payment event and moved
    // the status to active first. The unresolved failure row is the evidence.
    rowsOf('failed_payments').push({
      id: 1,
      subscriptionId: 42,
      resolved: false,
      createdAt: new Date(),
    });

    await call('handleInvoicePaymentSucceeded', PAID_INVOICE);

    expect(alerts.paymentSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({ wasPastDue: true }),
    );
    expect(rowsOf('failed_payments')[0].resolved).toBe(true);
  });

  it('an ordinary renewal reports no dunning', async () => {
    await call('handleInvoicePaymentSucceeded', PAID_INVOICE);

    expect(alerts.paymentSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({ wasPastDue: false }),
    );
  });

  it('says nothing for an invoice with no subscription', async () => {
    await call('handleInvoicePaymentSucceeded', { id: 'in_2' });

    expect(alerts.paymentSucceeded).not.toHaveBeenCalled();
  });
});
