/**
 * The writer that was missing — and then claimed too much.
 *
 * Migration 0032 created `provider_subscriptions`, six files were changed to
 * READ from it, and nothing was ever changed to WRITE the BASE_PLAN row — the
 * only INSERT in `src/` lived inside `StripeAdapter.purchaseAddon` and writes
 * add-on item types. So the table that decides "is this account being billed"
 * was empty for the entire paying population.
 *
 * THE FAKE WAS UPGRADED, and the reason is the eighth incarnation itself.
 *
 * This file used to mock `db` wholesale as `{ insert, update }` returning bare
 * recorders, and asserted on the VALUES handed to `insert` rather than on the
 * state that resulted. That fake was structurally incapable of expressing the
 * bug: it had no `select` at all (so the delegated `is_default` claim could not
 * run), no table awareness (so a Lemon Squeezy row could not exist beside a
 * Stripe one), and no `where` (so nothing could be scoped). Every
 * `one_default_idx` test on this branch covered the RELEASE direction — we
 * tested giving the flag up and never taking it, and the two specs exercising
 * this writer contained zero mentions of `lemonsqueezy`.
 *
 * So it now uses the table-keyed interpreter from
 * `reset-billing-state.provider-row.spec.ts` / `webhook.provider-row.spec.ts`,
 * where writes are visible to later reads and assertions are on resulting
 * STATE. That is what lets a test seed a live Lemon Squeezy default and assert
 * the invariant the partial unique index enforces in Postgres — anything live
 * implies exactly one `is_default`, and that row is itself live — rather than
 * only the field that changed.
 *
 * ts-jest is transpile-only here, so every assertion below is on a runtime
 * value rather than a type.
 */

/* The fakes stand in for drizzle's fluent builders; `any` is confined to them. */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

interface Row {
  [column: string]: unknown;
}

let tables: Record<string, Row[]>;
let insertShouldThrow: Error | null;
/** The `set:` clauses handed to `onConflictDoUpdate`, for the redelivery test. */
let conflictSets: Row[];

/** Drizzle hangs the SQL name off a symbol; reading it makes the fake table-aware. */
function tableName(t: unknown): string {
  const sym = Object.getOwnPropertySymbols(t as object).find((s) =>
    String(s).includes('Name'),
  );
  const name = sym ? (t as any)[sym] : undefined;
  return typeof name === 'string' ? name : 'unknown';
}

/**
 * `eq(column, value)` serialises to chunks `['', {name}, ' = ', value, '']`, and
 * `and(...)` NESTS those inside its own chunks, so the walk is recursive.
 * Flattening yields the column/value pairs, which is all this file's callers
 * ever build. An unrecognised shape THROWS rather than falling back to "match
 * everything" — a fake that silently widens is how a mutation check ends up
 * testing nothing, which is precisely the failure this file is being repaired
 * for.
 *
 * Ported from `reset-billing-state.provider-row.spec.ts`, minus its
 * subquery-`in` branch: nothing reachable from this file builds one, so
 * accepting it here would only widen what the fake tolerates.
 */
type Predicate = (row: Row) => boolean;

/** A drizzle column chunk, as opposed to a literal or an operator. */
function isColumn(chunk: unknown): boolean {
  return (
    !!chunk &&
    typeof chunk === 'object' &&
    typeof (chunk as any).name === 'string'
  );
}

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
    if (isColumn(chunk)) {
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

  // Matching everything would be the silent widening this interpreter exists
  // to prevent, so a clause the walk understood nothing of is a failure.
  if (pairs.length === 0) {
    throw new Error('The db fake understood no column in this clause.');
  }

  return (row: Row) =>
    pairs.every((p) => {
      const actual = row[p.column];
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

let nextId = 100;

const mockDb: any = {
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
      limit: () => chain,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(rowsOf(target).filter(match)).then(resolve),
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
  /**
   * A REAL upsert on `(subscription_id, provider, item_type)` — the actual
   * ON CONFLICT target. Arbitrating that tuple and NOTHING else is the whole
   * point: a `provider = 'stripe'` insert must not be absorbed by an existing
   * `provider = 'lemonsqueezy'` row, because in Postgres it is not, and that
   * is exactly how the hardcoded `is_default: true` reached a second index.
   */
  insert: (t: unknown) => {
    const target = tableName(t);
    let pending: Row = {};
    const chain: any = {
      values: (v: Row) => {
        pending = { ...v };
        return chain;
      },
      onConflictDoUpdate: (arg: { set: Row }) => {
        conflictSets.push(arg.set);
        if (insertShouldThrow) return Promise.reject(insertShouldThrow);
        const rows = rowsOf(target);
        const existing = rows.find(
          (r) =>
            r.subscriptionId === pending.subscriptionId &&
            r.provider === pending.provider &&
            r.itemType === pending.itemType,
        );
        if (existing) {
          Object.assign(existing, arg.set);
          return Promise.resolve([{ id: existing.id }]);
        }
        const row = { id: nextId++, ...pending };
        rows.push(row);
        return Promise.resolve([{ id: row.id }]);
      },
    };
    return chain;
  },
};

jest.mock('../../drizzle/db', () => ({ db: mockDb }));

import { Logger } from '@nestjs/common';
import {
  writeStripeBasePlanRow,
  expireStripeProviderRows,
} from './stripe-provider-row.util';
// The REAL liveness predicate every billing branch reads.
import { isLive } from '../services/provider-subscription.util';

const SUBSCRIPTION_ID = 42;

beforeEach(() => {
  jest.clearAllMocks();
  tables = { provider_subscriptions: [] };
  conflictSets = [];
  insertShouldThrow = null;
  nextId = 100;
});

function stripeSub(over: Record<string, unknown> = {}) {
  return {
    id: 'sub_live',
    status: 'active',
    cancel_at_period_end: false,
    items: {
      data: [
        {
          id: 'si_base',
          price: { id: 'price_pro' },
          current_period_end: 1_800_000_000,
        },
      ],
    },
    ...over,
  } as never;
}

function write(over: Record<string, unknown> = {}) {
  return writeStripeBasePlanRow({
    subscriptionId: SUBSCRIPTION_ID,
    stripeSubscription: stripeSub(over),
    stripeCustomerId: 'cus_live',
    unitPriceCents: 20000,
  });
}

function providerRows(): Row[] {
  return rowsOf('provider_subscriptions');
}

function stripeRow(): Row {
  return providerRows().find((r) => r.provider === 'stripe') as Row;
}

function lsRow(): Row {
  return providerRows().find((r) => r.provider === 'lemonsqueezy') as Row;
}

/** A Lemon Squeezy BASE_PLAN already holding the account's default. */
function seedLemonSqueezyDefault(over: Row = {}): void {
  providerRows().push({
    id: 1,
    subscriptionId: SUBSCRIPTION_ID,
    provider: 'lemonsqueezy',
    itemType: 'BASE_PLAN',
    providerSubscriptionId: 'ls_sub_1',
    providerStatus: 'active',
    providerQuantity: 1,
    endsAt: null,
    isDefault: true,
    ...over,
  });
}

/**
 * The invariant `provider_subscriptions_one_default_idx` enforces in Postgres,
 * plus the half the index cannot express. Asserted instead of only the field
 * under edit, because "Stripe's row is false" also holds in the BROKEN state
 * where nobody holds the flag — zero defaults while two providers charge,
 * which reads as unbilled and opens a third subscription.
 */
function expectExactlyOneLiveDefault(): Row {
  const rows = providerRows();
  const defaults = rows.filter((r) => r.isDefault === true);
  expect(defaults).toHaveLength(1);
  expect(isLive(defaults[0] as never)).toBe(true);
  return defaults[0];
}

describe('writeStripeBasePlanRow', () => {
  it('writes the BASE_PLAN row that every paid/unpaid branch reads', async () => {
    await write();

    expect(providerRows()).toHaveLength(1);
    const row = stripeRow();
    expect(row.subscriptionId).toBe(42);
    expect(row.provider).toBe('stripe');
    // Without exactly this value `hasLiveBasePlan` finds nothing and the
    // account reads as unbilled.
    expect(row.itemType).toBe('BASE_PLAN');
    expect(row.providerSubscriptionId).toBe('sub_live');
    expect(row.providerCustomerId).toBe('cus_live');
    expect(row.providerItemId).toBe('si_base');
    expect(row.providerPriceId).toBe('price_pro');
    expect(row.providerStatus).toBe('active');
  });

  it('ends up holding the default when nothing else on the account is live', async () => {
    // The ordinary case, and the reason the claim could not simply be deleted:
    // a Stripe row that never takes the flag leaves `pickDefaultProvider`
    // returning null and `hasLiveBasePlan` answering false for a customer
    // Stripe is demonstrably charging. The flag is now CLAIMED rather than
    // hardcoded, so this asserts the resulting state, not the insert values.
    await write();

    expect(stripeRow().isDefault).toBe(true);
    expect(expectExactlyOneLiveDefault().provider).toBe('stripe');
  });

  it('never moves the default-provider flag on a redelivered webhook', async () => {
    // Stripe redelivers `checkout.session.completed`. During the LS -> Stripe
    // window the flag says which provider currently bills the account, and a
    // redelivery must not silently move it — 0032's partial unique index
    // permits one true row per subscription, so flipping it could also 23505.
    await write();

    expect(conflictSets).toHaveLength(1);
    expect('isDefault' in conflictSets[0]).toBe(false);
  });

  it('treats the period end as a RENEWAL, not an expiry, for a healthy subscription', async () => {
    // `isLive()` reads `endsAt`. Writing a renewal date into it would make
    // every healthy subscriber read as expired the moment their period rolled
    // over — the billing-after-cancel bug, rebuilt from the other direction.
    await write();

    expect(stripeRow().endsAt).toBeNull();
    expect(stripeRow().renewsAt).toBeInstanceOf(Date);
  });

  it('records a genuine end date once the subscription is set to cancel', async () => {
    await write({ cancel_at_period_end: true });

    expect(stripeRow().endsAt).toBeInstanceOf(Date);
    expect(stripeRow().renewsAt).toBeNull();
  });

  it('swallows a write failure instead of failing an already-charged request', async () => {
    // It runs after the customer has been charged and after `subscriptions`
    // has been written. Throwing here would tell the caller the subscription
    // did not happen when it demonstrably did.
    insertShouldThrow = new Error('deadlock detected');

    await expect(write()).resolves.toBeUndefined();
  });

  // ------------------------------------------------- the CLAIM direction
  //
  // The eighth incarnation. Every `one_default_idx` test on this branch until
  // now covered RELEASING the flag; these cover TAKING it, with a live Lemon
  // Squeezy default already sitting in the slot.

  describe('when a live Lemon Squeezy row already holds the default', () => {
    it('does not claim is_default on the insert, which would raise 23505', async () => {
      // The ON CONFLICT target is (subscription_id, provider, item_type), so
      // this INSERT does not conflict with the Lemon Squeezy row at all — it
      // proceeds as a genuine insert. Carrying `is_default = true` would then
      // violate `provider_subscriptions_one_default_idx`, a DIFFERENT index
      // an explicit conflict target cannot absorb, and the catch swallows the
      // error: 200 back to Stripe, no retry, and NO Stripe row at all.
      seedLemonSqueezyDefault();

      await write();

      // A real INSERT happened; it was not absorbed by the LS row.
      expect(providerRows()).toHaveLength(2);
      expect(stripeRow()).toBeDefined();
      expect(stripeRow().providerSubscriptionId).toBe('sub_live');
    });

    it('leaves the flag on the LEMON SQUEEZY row, which is the one still cancellable', async () => {
      // Which provider owns the flag decides where `adapterForSubscription`
      // routes every cancel and plan change. The incumbent keeps it: seizing
      // it for Stripe would strip the live LS subscription of the only pointer
      // anything holds to it, so no cancel path could reach it and it would
      // bill forever. Leaving it defers Stripe's ownership by at most one
      // period, until the LS row lapses and the Lemon Squeezy termination
      // path's own `rehomeDefault` hands it over. One failure is permanent,
      // the other self-heals.
      seedLemonSqueezyDefault();

      await write();

      expect(lsRow().isDefault).toBe(true);
      expect(stripeRow().isDefault).toBe(false);
    });

    it('holds the one-live-default invariant, not merely the field under edit', async () => {
      seedLemonSqueezyDefault();

      await write();

      expect(expectExactlyOneLiveDefault().provider).toBe('lemonsqueezy');
    });

    it('still leaves the account routable when the LS row is cancelled but not yet expired', async () => {
      // The Lemon Squeezy trap: `cancelled` is NOT dead — the customer keeps
      // access until `ends_at`, and `isLive` says so. A liveness check written
      // as a status-string comparison would hand Stripe the flag here and
      // strand an LS subscription that is still charging.
      seedLemonSqueezyDefault({
        providerStatus: 'cancelled',
        endsAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      });

      await write();

      expect(lsRow().isDefault).toBe(true);
      expect(expectExactlyOneLiveDefault().provider).toBe('lemonsqueezy');
    });

    it('protects the incumbent even when the Stripe row is scanned FIRST', async () => {
      // ORDER-INDEPENDENCE, and it is not a hypothetical. `rehomeDefault`
      // picks its heir with `candidates.find(itemType === 'BASE_PLAN')`, which
      // returns whichever BASE_PLAN the driver happened to return first. In
      // every other test here the Lemon Squeezy row is seeded first and
      // therefore wins that `find` on its own — so those tests still passed
      // with BOTH of `rehomeDefault`'s guards deleted, and were pinning row
      // order rather than the protection. A real `SELECT` has no ORDER BY and
      // guarantees no order at all.
      //
      // So this seeds the Stripe row FIRST, with the flag on the live Lemon
      // Squeezy row behind it. Now `find` reaches the Stripe row first and
      // only the incumbent guard can stop the steal — which is exactly the
      // eighth incarnation reappearing through a different door, since a
      // Stripe row that seizes the flag strands a live LS subscription that
      // nothing can then cancel.
      providerRows().push({
        id: 9,
        subscriptionId: SUBSCRIPTION_ID,
        provider: 'stripe',
        itemType: 'BASE_PLAN',
        providerSubscriptionId: 'sub_live',
        providerStatus: 'active',
        providerQuantity: 1,
        endsAt: null,
        isDefault: false,
      });
      seedLemonSqueezyDefault();

      await write();

      // The upsert matched the pre-seeded Stripe row rather than inserting.
      expect(providerRows()).toHaveLength(2);
      expect(stripeRow().isDefault).toBe(false);
      expect(lsRow().isDefault).toBe(true);
      expect(expectExactlyOneLiveDefault().provider).toBe('lemonsqueezy');
    });

    it('stays idempotent across a redelivery instead of flipping the flag', async () => {
      // Stripe redelivers, and Lemon Squeezy's row is still billing. The
      // second pass must reach exactly the same state as the first — a
      // redelivery that moved the flag would reroute every cancel on the
      // account, silently, long after the money moved.
      seedLemonSqueezyDefault();

      await write();
      await write();

      expect(providerRows()).toHaveLength(2);
      expect(lsRow().isDefault).toBe(true);
      expect(stripeRow().isDefault).toBe(false);
      expect(expectExactlyOneLiveDefault().provider).toBe('lemonsqueezy');
    });

    // ----------------------------------------------- observability finding
    //
    // The merge-gate review's Important finding: this exact shape — a Stripe
    // row inserted `isDefault: false` beside a live Lemon Squeezy default, an
    // account now paying BOTH providers — produced zero log lines. The
    // incumbent guard inside `rehomeDefault` is a bare early-return with no
    // log, so `hasLegacyProvider` (previously wired nowhere) now names it.

    it('warns that the account is billed by two providers at once', async () => {
      seedLemonSqueezyDefault();
      const warnSpy = jest.spyOn(Logger.prototype, 'warn');

      await write();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = warnSpy.mock.calls[0][0] as string;
      expect(message).toContain('TWO providers');
      expect(message).toContain('lemonsqueezy');
      expect(message).toContain('stripe');
      expect(message).toContain(String(SUBSCRIPTION_ID));
      warnSpy.mockRestore();
    });

    it('does NOT warn on an ordinary redelivery where nothing dual-bills', async () => {
      // The counter-case a test suite must carry or the warn above is
      // unfalsifiable: seed a Stripe account with no other live provider,
      // then redeliver the webhook. The incumbent guard fires (idempotent
      // no-op) but there is only ever one live provider, so this must stay
      // quiet rather than train an on-call human to ignore the warning.
      await write();
      const warnSpy = jest.spyOn(Logger.prototype, 'warn');

      await write();

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('when the Lemon Squeezy row on the account is dead', () => {
    it('takes the vacated default, since Stripe is the only provider billing', async () => {
      // The other half of the cutover, and the reason the claim is DELEGATED
      // rather than deleted. This is the completed hand-off: the LS lifecycle
      // released the flag when it wrote the terminal status (every Lemon
      // Squeezy termination path sets `is_default = false` in the SAME UPDATE
      // as `provider_status`, so a dead row still holding it is not a state
      // the system can produce), leaving the slot empty. If the Stripe row
      // did not claim it here, `pickDefaultProvider` would return null and
      // `hasLiveBasePlan` would answer false for a customer Stripe is
      // charging — the exact defect the whole re-home mechanism exists for,
      // reached from the opposite side.
      seedLemonSqueezyDefault({ providerStatus: 'expired', isDefault: false });

      await write();

      expect(stripeRow().isDefault).toBe(true);
      expect(expectExactlyOneLiveDefault().provider).toBe('stripe');
    });
  });
});

describe('expireStripeProviderRows', () => {
  it('marks the rows expired rather than deleting the record', async () => {
    providerRows().push({
      id: 1,
      subscriptionId: SUBSCRIPTION_ID,
      provider: 'stripe',
      itemType: 'BASE_PLAN',
      providerStatus: 'active',
      isDefault: true,
    });

    await expireStripeProviderRows(SUBSCRIPTION_ID);

    // `isLive()` reads `expired` as not billing, which is what routes a stale
    // account to Checkout instead of back to a dead Stripe id.
    expect(stripeRow().providerStatus).toBe('expired');
  });

  it('leaves a live Lemon Squeezy row alone, being scoped to provider = stripe', async () => {
    // The stale-id recovery says nothing about the other provider, and an
    // account mid-cutover can hold both.
    seedLemonSqueezyDefault();
    providerRows().push({
      id: 2,
      subscriptionId: SUBSCRIPTION_ID,
      provider: 'stripe',
      itemType: 'BASE_PLAN',
      providerStatus: 'active',
      isDefault: false,
    });

    await expireStripeProviderRows(SUBSCRIPTION_ID);

    expect(stripeRow().providerStatus).toBe('expired');
    expect(lsRow().providerStatus).toBe('active');
    expect(expectExactlyOneLiveDefault().provider).toBe('lemonsqueezy');
  });
});
