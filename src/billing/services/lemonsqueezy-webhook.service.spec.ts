/**
 * Lemon Squeezy webhooks.
 *
 * This branch's recurring defect is state that something READS but nothing
 * reliably WRITES or INVALIDATES. It relocated four times across Task 11, and
 * the fourth was the Stripe webhook: it nulled `stripe_subscription_id` and
 * left the `provider_subscriptions` row reading `active` / `is_default = true`,
 * so the customer could never re-subscribe — the branch that decides whether an
 * account is being billed read a live-looking row naming a dead subscription,
 * and the one `is_default` slot the partial unique index allows stayed taken.
 *
 * This file is the Lemon Squeezy equivalent, so it asserts on the RESULTING
 * STATE of both tables after every event that ends or suspends a subscription,
 * never on a function having been called. ts-jest runs `isolatedModules`
 * (transpile-only), so a type-level assertion would be vacuous at runtime;
 * every assertion below is on a runtime value.
 *
 * THE FAKE is the table-keyed store from `webhook.provider-row.spec.ts`, not
 * the positional queue the older specs use. A positional fake is table-blind:
 * a write is never visible to a later select, so a write/read mismatch — the
 * exact class of bug under test — cannot be caught at all.
 */

/* The fakes stand in for drizzle's fluent builders, whose chain types are not
   expressible here — `any` is deliberate and confined to the fakes. */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import * as crypto from 'crypto';

interface Row {
  [column: string]: unknown;
}

/** table name -> rows. The whole database, for one test. */
let tables: Record<string, Row[]>;

/**
 * Which table a drizzle table object refers to. Drizzle hangs the SQL name off
 * a symbol; reading it is what makes this fake table-AWARE.
 */
function tableName(t: unknown): string {
  const sym = Object.getOwnPropertySymbols(t as object).find((s) =>
    String(s).includes('Name'),
  );
  const name = sym ? (t as any)[sym] : undefined;
  return typeof name === 'string' ? name : 'unknown';
}

/**
 * A REAL predicate, built by walking drizzle's `queryChunks`.
 *
 * A wide-open predicate would be worse than useless here. Every routing
 * decision in the service is a `where` — "which provider row does this
 * provider_subscription_id name", "does this account already hold a default",
 * "which subscription_items row belongs to this add-on" — so a fake that
 * ignores `where` makes the routing tests assert nothing: the first row in the
 * table answers every query and an add-on event appears to update the base
 * plan correctly. That is exactly the class of silent agreement between test
 * and code this branch keeps producing.
 *
 * `eq(column, value)` serialises to chunks `['', {name}, ' = ', value, '']`, and
 * `and(...)` NESTS those inside its own chunks, so the walk is recursive.
 * Flattening yields the column/value pairs, which is all the service ever
 * builds. An unrecognised shape throws rather than falling back to "match
 * everything" — a fake that silently widens is how a mutation check ends up
 * testing nothing.
 */
type Predicate = (row: Row) => boolean;

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
    if (chunk && typeof chunk === 'object' && typeof chunk.name === 'string') {
      // ['', {name}, ' = ', value, ...]
      const op = chunks[i + 1] as any;
      const opText = Array.isArray(op?.value) ? String(op.value[0]) : '';
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

  if (pairs.length === 0) {
    throw new Error('The db fake found no comparisons in a where clause.');
  }

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

function makeDb(): any {
  return {
    /**
     * `select()` honours its PROJECTION, because the service aliases columns
     * (`{ rowId: providerSubscriptions.id }`) and then reads the alias back. A
     * fake that returned whole rows would hand back `undefined` for every
     * aliased field, and the subsequent `where(eq(id, undefined))` would match
     * nothing — silently, since a webhook handler that finds no row just logs
     * and returns.
     */
    select: (projection?: Record<string, unknown>) => {
      let target = 'unknown';
      let match: Predicate = () => true;
      const project = (row: Row): Row => {
        if (!projection) return row;
        const out: Row = {};
        for (const [alias, column] of Object.entries(projection)) {
          const name = (column as any)?.name;
          out[alias] = typeof name === 'string' ? row[camel(name)] : undefined;
        }
        return out;
      };
      const chain: any = {
        from: (t: unknown) => {
          target = tableName(t);
          return chain;
        },
        innerJoin: () => chain,
        leftJoin: () => chain,
        where: (c: unknown) => {
          match = predicateFrom(c);
          return chain;
        },
        orderBy: () => chain,
        limit: () => chain,
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(rowsOf(target).filter(match).map(project)).then(
            resolve,
          ),
      };
      return chain;
    },

    insert: (t: unknown) => {
      const target = tableName(t);
      let last: Row[] = [];
      const chain: any = {
        values: (v: Row | Row[]) => {
          const incoming = Array.isArray(v) ? v : [v];
          last = [];
          for (const row of incoming) {
            const stored = { id: rowsOf(target).length + 1, ...row };
            rowsOf(target).push(stored);
            last.push(stored);
          }
          return chain;
        },
        onConflictDoUpdate: () => chain,
        onConflictDoNothing: () => chain,
        returning: (projection?: Record<string, unknown>) => {
          if (!projection) return Promise.resolve(last);
          return Promise.resolve(
            last.map((row) => {
              const out: Row = {};
              for (const [alias, column] of Object.entries(projection)) {
                const name = (column as any)?.name;
                out[alias] =
                  typeof name === 'string' ? row[camel(name)] : undefined;
              }
              return out;
            }),
          );
        },
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(last).then(resolve),
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
  };
}

const mockDb = makeDb();
jest.mock('../../drizzle/db', () => ({ db: mockDb }));

import { LemonSqueezyWebhookService } from './lemonsqueezy-webhook.service';

const SUBSCRIPTION_ID = 42;
const LS_SUB = 'ls_sub_base';
const LS_ADDON_SUB = 'ls_sub_channels';

const lookup = {
  findByUserId: jest.fn().mockResolvedValue({ id: SUBSCRIPTION_ID }),
  getAddonQuantities: jest.fn().mockResolvedValue({
    extraChannels: 0,
    extraMembers: 0,
    extraWorkspaces: 0,
    extraAiTokens: 0,
  }),
  applyLimitsToAllWorkspaces: jest.fn().mockResolvedValue(undefined),
};

function make(): LemonSqueezyWebhookService {
  return new LemonSqueezyWebhookService(lookup as never);
}

/** A paying Lemon Squeezy account: a base plan and one add-on subscription. */
function seedPayingAccount(): void {
  tables = {
    subscriptions: [
      {
        id: SUBSCRIPTION_ID,
        userId: 'user-1',
        planCode: 'PRO',
        status: 'active',
        cancelAtPeriodEnd: false,
        scheduledPlanCode: null,
        scheduledChangeAt: null,
      },
    ],
    provider_subscriptions: [
      {
        id: 1,
        subscriptionId: SUBSCRIPTION_ID,
        provider: 'lemonsqueezy',
        itemType: 'BASE_PLAN',
        providerSubscriptionId: LS_SUB,
        providerStatus: 'active',
        providerQuantity: 1,
        endsAt: null,
        renewsAt: new Date('2026-10-07'),
        isDefault: true,
      },
      {
        id: 2,
        subscriptionId: SUBSCRIPTION_ID,
        provider: 'lemonsqueezy',
        itemType: 'EXTRA_CHANNEL',
        providerSubscriptionId: LS_ADDON_SUB,
        providerStatus: 'active',
        providerQuantity: 3,
        endsAt: null,
        renewsAt: new Date('2026-10-07'),
        isDefault: false,
      },
    ],
    subscription_items: [
      {
        id: 1,
        subscriptionId: SUBSCRIPTION_ID,
        itemType: 'EXTRA_CHANNEL',
        quantity: 3,
      },
    ],
  };
}

function baseRow(): Row {
  return rowsOf('provider_subscriptions').find(
    (r) => r.providerSubscriptionId === LS_SUB,
  ) as Row;
}
function addonRow(): Row {
  return rowsOf('provider_subscriptions').find(
    (r) => r.providerSubscriptionId === LS_ADDON_SUB,
  ) as Row;
}
function accountRow(): Row {
  return rowsOf('subscriptions')[0];
}

/** A lifecycle payload: `data` IS the subscription. */
function lifecycle(
  id: string,
  attributes: Record<string, unknown>,
  custom?: Record<string, unknown>,
): unknown {
  return {
    meta: custom ? { custom_data: custom } : {},
    data: { id, type: 'subscriptions', attributes },
  };
}

/** A payment payload: a subscription INVOICE, a different shape entirely. */
function invoice(subscriptionId: string): unknown {
  return {
    meta: {},
    data: {
      id: 'ls_invoice_9',
      type: 'subscription-invoices',
      attributes: { subscription_id: subscriptionId, status: 'paid' },
    },
  };
}

beforeEach(() => {
  seedPayingAccount();
  jest.clearAllMocks();
});

// --------------------------------------------------------------- signature

function sign(raw: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(raw).digest('hex');
}

describe('LemonSqueezyWebhookService.verifySignature', () => {
  const OLD = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  beforeEach(() => {
    process.env.LEMONSQUEEZY_WEBHOOK_SECRET = 'shhh';
  });
  afterEach(() => {
    if (OLD === undefined) delete process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
    else process.env.LEMONSQUEEZY_WEBHOOK_SECRET = OLD;
  });

  it('accepts a correctly signed body', () => {
    const raw = '{"meta":{"event_name":"subscription_created"}}';
    expect(make().verifySignature(Buffer.from(raw), sign(raw, 'shhh'))).toBe(
      true,
    );
  });

  it('rejects a body signed with the wrong secret', () => {
    const raw = '{"meta":{}}';
    expect(make().verifySignature(Buffer.from(raw), sign(raw, 'wrong'))).toBe(
      false,
    );
  });

  it('rejects a tampered body', () => {
    const raw = '{"meta":{}}';
    const sig = sign(raw, 'shhh');
    expect(make().verifySignature(Buffer.from('{"meta":{"x":1}}'), sig)).toBe(
      false,
    );
  });

  it('rejects a malformed signature without throwing', () => {
    expect(make().verifySignature(Buffer.from('{}'), 'not-hex')).toBe(false);
  });

  it('rejects a missing signature header without throwing', () => {
    expect(make().verifySignature(Buffer.from('{}'), undefined as never)).toBe(
      false,
    );
  });

  it('rejects when no secret is configured, rather than accepting everything', () => {
    delete process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
    const raw = '{}';
    expect(make().verifySignature(Buffer.from(raw), sign(raw, 'shhh'))).toBe(
      false,
    );
  });

  it('rejects a signature of the wrong LENGTH without throwing', () => {
    // `crypto.timingSafeEqual` throws a RangeError when the two buffers differ
    // in length, so the length guard before it is load-bearing: without it a
    // truncated header becomes an uncaught 500, which Lemon Squeezy then
    // retries forever instead of treating as a rejected delivery. Both a short
    // and an over-long signature must be a quiet `false`.
    const raw = '{"a":1}';
    const good = sign(raw, 'shhh');
    const service = make();
    expect(service.verifySignature(Buffer.from(raw), good.slice(0, 32))).toBe(
      false,
    );
    expect(service.verifySignature(Buffer.from(raw), good + 'ab')).toBe(false);
  });

  it('verifies the RAW bytes, not a re-serialised body', () => {
    // `JSON.parse` then `JSON.stringify` reorders keys and drops whitespace, so
    // a route that verified against a re-serialised body would reject every
    // genuine webhook. The signature is computed over bytes that only survive
    // if the raw buffer is what reaches this function.
    const raw = '{ "b":2,\n  "a":1 }';
    const reserialised = JSON.stringify(JSON.parse(raw));
    expect(reserialised).not.toBe(raw);

    const sig = sign(raw, 'shhh');
    expect(make().verifySignature(Buffer.from(raw), sig)).toBe(true);
    expect(make().verifySignature(Buffer.from(reserialised), sig)).toBe(false);
  });
});

// ------------------------------------------------------------ status mapping

describe('base-plan lifecycle', () => {
  it('cancelled keeps the customer live: active + cancelAtPeriodEnd, is_default KEPT', async () => {
    // The trap this whole branch is about. Lemon Squeezy `cancelled` does NOT
    // revoke — the customer runs to `ends_at`. Releasing `is_default` here
    // would lose the account's live provider mid-period.
    await make().handleEvent(
      'subscription_cancelled',
      lifecycle(LS_SUB, {
        status: 'cancelled',
        ends_at: '2026-10-07T00:00:00.000Z',
        renews_at: null,
      }),
    );

    expect(accountRow().status).toBe('active');
    expect(accountRow().cancelAtPeriodEnd).toBe(true);
    expect(accountRow().planCode).toBe('PRO');
    expect(baseRow().providerStatus).toBe('cancelled');
    expect(baseRow().isDefault).toBe(true);
    expect(rowsOf('subscription_items')).toHaveLength(1);
  });

  it('expired revokes: FREE, provider row dead, is_default RELEASED, items gone', async () => {
    // The Stripe defect, inverted onto Lemon Squeezy. A dead row that kept
    // `is_default` squats on the single slot the partial unique index allows,
    // and the customer can never subscribe again.
    await make().handleEvent(
      'subscription_expired',
      lifecycle(LS_SUB, {
        status: 'expired',
        ends_at: '2026-09-07T00:00:00.000Z',
        renews_at: null,
      }),
    );

    expect(accountRow().planCode).toBe('FREE');
    expect(accountRow().status).toBe('canceled');
    expect(baseRow().providerStatus).toBe('expired');
    expect(baseRow().isDefault).toBe(false);
    expect(baseRow().renewsAt).toBeNull();
    // The add-on subscriptions die with it — otherwise they read as live
    // billing forever and hold their own flags.
    expect(addonRow().providerStatus).toBe('expired');
    expect(addonRow().isDefault).toBe(false);
    expect(rowsOf('subscription_items')).toHaveLength(0);
    expect(lookup.applyLimitsToAllWorkspaces).toHaveBeenCalledWith(
      'user-1',
      'FREE',
      expect.objectContaining({ extraChannels: 0 }),
    );
  });

  it('paused stays live at FREE limits and keeps is_default', async () => {
    await make().handleEvent(
      'subscription_paused',
      lifecycle(LS_SUB, { status: 'paused' }),
    );

    expect(accountRow().status).toBe('paused');
    expect(accountRow().planCode).toBe('PRO');
    expect(baseRow().providerStatus).toBe('paused');
    expect(baseRow().isDefault).toBe(true);
  });

  it('unpaid folds into past_due and does not revoke', async () => {
    await make().handleEvent(
      'subscription_updated',
      lifecycle(LS_SUB, { status: 'unpaid' }),
    );

    expect(accountRow().status).toBe('past_due');
    expect(accountRow().planCode).toBe('PRO');
    expect(baseRow().isDefault).toBe(true);
  });

  it('resumed returns the account to active', async () => {
    accountRow().status = 'paused';
    baseRow().providerStatus = 'paused';

    await make().handleEvent(
      'subscription_resumed',
      lifecycle(LS_SUB, {
        status: 'active',
        renews_at: '2026-11-07T00:00:00Z',
      }),
    );

    expect(accountRow().status).toBe('active');
    expect(baseRow().providerStatus).toBe('active');
    expect(baseRow().renewsAt).toBeInstanceOf(Date);
  });
});

// ------------------------------------------------------------------ routing

describe('routing by item_type', () => {
  it('reads item_type from the ROW, so an add-on event never touches the plan', async () => {
    // The routing decision is the stored column, never the variant id. A
    // variant map read at webhook time breaks silently the first time the
    // catalogue changes — here the add-on carries the BASE PLAN's variant id
    // and must STILL be routed as an add-on.
    await make().handleEvent(
      'subscription_updated',
      lifecycle(LS_ADDON_SUB, {
        status: 'cancelled',
        variant_id: 'variant-of-the-base-plan',
        ends_at: '2026-10-07T00:00:00.000Z',
      }),
    );

    expect(addonRow().providerStatus).toBe('cancelled');
    // Untouched: the account is not cancelling, one add-on is.
    expect(accountRow().status).toBe('active');
    expect(accountRow().cancelAtPeriodEnd).toBe(false);
    expect(accountRow().planCode).toBe('PRO');
    expect(baseRow().providerStatus).toBe('active');
  });

  it('an expired add-on drops only its own entitlement row', async () => {
    await make().handleEvent(
      'subscription_expired',
      lifecycle(LS_ADDON_SUB, { status: 'expired' }),
    );

    expect(addonRow().providerStatus).toBe('expired');
    expect(rowsOf('subscription_items')).toHaveLength(0);
    // The plan itself survives.
    expect(accountRow().planCode).toBe('PRO');
    expect(baseRow().providerStatus).toBe('active');
    expect(baseRow().isDefault).toBe(true);
  });

  it('an expiring row RELEASES is_default even when the base plan is untouched', async () => {
    // Isolates the `is_default` release on the row the event names, which the
    // base-plan test cannot: there, `revokeBasePlan` sweeps every Lemon
    // Squeezy row afterwards and would mask a missing release on the primary
    // write. Here nothing sweeps, so only the write under test can clear it.
    //
    // The seeded shape is real, not contrived: during the cutover an account's
    // default can sit on a row that is not its base plan, and a dead row that
    // keeps the flag squats on the single slot
    // `provider_subscriptions_one_default_idx` allows — the customer then
    // cannot subscribe at the other provider at all. That is the Task 11
    // defect, and this is where it would reappear.
    baseRow().isDefault = false;
    addonRow().isDefault = true;

    await make().handleEvent(
      'subscription_expired',
      lifecycle(LS_ADDON_SUB, { status: 'expired' }),
    );

    expect(addonRow().providerStatus).toBe('expired');
    expect(addonRow().isDefault).toBe(false);
  });

  it('cancelled does NOT release is_default — Lemon Squeezy is still billing', async () => {
    // The mirror of the test above, and the reason termination and
    // cancellation cannot share a code path. Releasing the flag here would
    // lose the account's live provider mid-period: `pickDefaultProvider`
    // returns null, `findItem` finds nothing, and a customer who is still
    // paying reads as having no provider at all.
    baseRow().isDefault = false;
    addonRow().isDefault = true;

    await make().handleEvent(
      'subscription_cancelled',
      lifecycle(LS_ADDON_SUB, {
        status: 'cancelled',
        ends_at: '2026-10-07T00:00:00.000Z',
      }),
    );

    expect(addonRow().providerStatus).toBe('cancelled');
    expect(addonRow().isDefault).toBe(true);
  });

  it('updates the billing quantity from first_subscription_item', async () => {
    await make().handleEvent(
      'subscription_updated',
      lifecycle(LS_ADDON_SUB, {
        status: 'active',
        first_subscription_item: { id: 'item_7', quantity: 5 },
      }),
    );

    expect(addonRow().providerQuantity).toBe(5);
    expect(addonRow().providerItemId).toBe('item_7');
  });

  it('ignores an event for a subscription we hold no row for', async () => {
    await make().handleEvent(
      'subscription_updated',
      lifecycle('ls_sub_someone_else', { status: 'expired' }),
    );

    expect(accountRow().planCode).toBe('PRO');
    expect(baseRow().providerStatus).toBe('active');
    expect(rowsOf('provider_subscriptions')).toHaveLength(2);
  });
});

// ----------------------------------------------------------------- creation

describe('subscription_created', () => {
  it('inserts the row from checkout_data.custom, reading item_type from it', async () => {
    tables.provider_subscriptions = [];

    await make().handleEvent(
      'subscription_created',
      lifecycle(
        'ls_sub_new',
        {
          status: 'active',
          customer_id: 555,
          variant_id: 999,
          renews_at: '2026-10-07T00:00:00.000Z',
          first_subscription_item: { id: 'item_1', quantity: 1 },
        },
        { user_id: 'user-1', item_type: 'BASE_PLAN', plan_code: 'PRO' },
      ),
    );

    const row = rowsOf('provider_subscriptions')[0];
    expect(row.provider).toBe('lemonsqueezy');
    expect(row.itemType).toBe('BASE_PLAN');
    expect(row.providerSubscriptionId).toBe('ls_sub_new');
    expect(row.providerCustomerId).toBe('555');
    expect(row.subscriptionId).toBe(SUBSCRIPTION_ID);
    // No other default existed, so this row becomes the account's provider.
    expect(row.isDefault).toBe(true);
    expect(accountRow().status).toBe('active');
  });

  it('does NOT claim is_default when the account already has one', async () => {
    // 23505 on the partial unique index would be raised AFTER Lemon Squeezy
    // has already taken the customer's money.
    await make().handleEvent(
      'subscription_created',
      lifecycle(
        'ls_sub_addon_new',
        { status: 'active', first_subscription_item: { id: 'i', quantity: 2 } },
        {
          user_id: 'user-1',
          item_type: 'EXTRA_MEMBER',
          subscription_id: String(SUBSCRIPTION_ID),
        },
      ),
    );

    const row = rowsOf('provider_subscriptions').find(
      (r) => r.providerSubscriptionId === 'ls_sub_addon_new',
    ) as Row;
    expect(row.itemType).toBe('EXTRA_MEMBER');
    expect(row.isDefault).toBe(false);
    // The existing default is untouched.
    expect(baseRow().isDefault).toBe(true);
  });

  it('writes nothing when the checkout carried no resolvable account', async () => {
    lookup.findByUserId.mockResolvedValueOnce(null);
    tables.provider_subscriptions = [];

    await make().handleEvent(
      'subscription_created',
      lifecycle(
        'ls_sub_orphan',
        { status: 'active' },
        { item_type: 'BASE_PLAN' },
      ),
    );

    expect(rowsOf('provider_subscriptions')).toHaveLength(0);
  });

  it('an event other than created never inserts a row', async () => {
    // An upsert here would claim `is_default` for an account whose provider is
    // not yet decided — the same reason `refreshStripeProviderRowStatus` is an
    // update and never an upsert.
    tables.provider_subscriptions = [];

    await make().handleEvent(
      'subscription_updated',
      lifecycle('ls_sub_unknown', { status: 'active' }, { user_id: 'user-1' }),
    );

    expect(rowsOf('provider_subscriptions')).toHaveLength(0);
  });
});

// ------------------------------------------------------------ payment events

describe('payment events (a subscription INVOICE, not a subscription)', () => {
  it('reads subscription_id from the attributes, not data.id', async () => {
    // `data.id` on these payloads is the INVOICE id. Reading it would look an
    // invoice id up in the subscription column and silently find nothing.
    await make().handleEvent('subscription_payment_failed', invoice(LS_SUB));

    expect(accountRow().status).toBe('past_due');
  });

  it('a recovered payment returns the account to active', async () => {
    accountRow().status = 'past_due';

    await make().handleEvent('subscription_payment_recovered', invoice(LS_SUB));

    expect(accountRow().status).toBe('active');
  });

  it('a refund does not end the subscription', async () => {
    await make().handleEvent('subscription_payment_refunded', invoice(LS_SUB));

    expect(accountRow().status).toBe('active');
    expect(accountRow().planCode).toBe('PRO');
    expect(baseRow().providerStatus).toBe('active');
  });

  it('an add-on invoice does not move the account status', async () => {
    await make().handleEvent(
      'subscription_payment_failed',
      invoice(LS_ADDON_SUB),
    );

    expect(accountRow().status).toBe('active');
  });

  it('a payment event with no subscription_id is ignored', async () => {
    await make().handleEvent('subscription_payment_failed', {
      meta: {},
      data: { id: 'inv_1', attributes: { status: 'paid' } },
    });

    expect(accountRow().status).toBe('active');
  });
});

// ------------------------------------------------------------ event ordering

describe('out-of-order delivery', () => {
  it('a stale active event cannot resurrect an expired subscription', async () => {
    // Lemon Squeezy does not guarantee ordering. Without this gate a late
    // `subscription_updated` carrying `active` would un-expire a terminated
    // account, restore its limits, and re-claim an `is_default` slot a fresh
    // signup at the other provider may already hold.
    baseRow().providerStatus = 'expired';
    baseRow().isDefault = false;
    accountRow().planCode = 'FREE';
    accountRow().status = 'canceled';

    await make().handleEvent(
      'subscription_updated',
      lifecycle(LS_SUB, {
        status: 'active',
        renews_at: '2026-11-07T00:00:00Z',
      }),
    );

    expect(baseRow().providerStatus).toBe('expired');
    expect(baseRow().isDefault).toBe(false);
    expect(accountRow().planCode).toBe('FREE');
    expect(accountRow().status).toBe('canceled');
  });

  it('a stale payment event cannot revive an expired account either', async () => {
    baseRow().providerStatus = 'expired';
    accountRow().status = 'canceled';

    await make().handleEvent('subscription_payment_success', invoice(LS_SUB));

    expect(accountRow().status).toBe('canceled');
  });

  it('a duplicate expired event is harmless', async () => {
    const payload = lifecycle(LS_SUB, {
      status: 'expired',
      ends_at: '2026-09-07T00:00:00.000Z',
    });

    await make().handleEvent('subscription_expired', payload);
    await make().handleEvent('subscription_expired', payload);

    expect(baseRow().providerStatus).toBe('expired');
    expect(baseRow().isDefault).toBe(false);
    expect(accountRow().planCode).toBe('FREE');
  });
});

describe('unhandled events', () => {
  it('an event we do not handle changes nothing', async () => {
    await make().handleEvent('order_created', lifecycle(LS_SUB, {}));

    expect(accountRow().planCode).toBe('PRO');
    expect(baseRow().providerStatus).toBe('active');
  });
});
