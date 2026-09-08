import {
  LEMONSQUEEZY_PRICES,
  resolvePrices,
  upsertProviderPrices,
  billableCatalogueKeys,
  missingCatalogueRows,
  type ResolvedPrice,
} from './provider-prices.seed';
import { CatalogueService } from '../../billing/providers/catalogue.service';
import type { ProviderItemType } from '../schema';

/**
 * The seed's job is to make `CatalogueService.resolveRef` answer. So the tests
 * assert against the REAL resolver wherever they can, rather than restating
 * what a row should look like — the branch's recurring defect has been a test
 * that pins the field it just wrote instead of the property that has to hold.
 */

interface PriceRow {
  provider: string;
  planCode: string | null;
  itemType: string;
  providerRef: string;
  isActive: boolean;
  updatedAt?: Date;
}

/**
 * An in-memory `provider_prices` that enforces the ONE thing the real table
 * enforces and the whole seed depends on: the unique constraint on
 * `(provider, plan_code, item_type)`. A fake that silently allows duplicates
 * would let the upsert be wrong and every test still pass.
 *
 * It reproduces Postgres's NULL semantics deliberately: two rows with a null
 * `plan_code` do NOT conflict, because that is exactly the trap the seed's
 * never-null rule exists to avoid, and a fake that deduped them would hide it.
 */
function makeStore(seed: PriceRow[] = []) {
  const rows: PriceRow[] = seed.map((r) => ({ ...r }));

  // provider_prices column name -> the PriceRow field holding it.
  const FIELD_OF: Record<string, keyof PriceRow> = {
    provider: 'provider',
    plan_code: 'planCode',
    item_type: 'itemType',
    provider_ref: 'providerRef',
    is_active: 'isActive',
  };

  /**
   * Build the dedupe key from the conflict target the CALLER declared, read off
   * the real drizzle column objects. An earlier version of this fake keyed on
   * the values instead, which made the target dead weight: dropping `plan_code`
   * from it changed nothing and every test still passed. Reading the target is
   * what makes it load-bearing, so a wrong target now fails here the way it
   * would fail against Postgres.
   */
  function keyFrom(
    target: { name: string }[],
    row: { provider: string; planCode: string | null; itemType: string },
  ): string | null {
    const parts: string[] = [];
    for (const col of target) {
      const field = FIELD_OF[col.name];
      if (!field) throw new Error(`unknown conflict-target column ${col.name}`);
      const value = (row as unknown as Record<string, unknown>)[field];
      // Postgres: NULL never equals NULL, so such a row conflicts with nothing.
      if (value === null || value === undefined) return null;
      // Narrowed to primitives on purpose. `String(anObject)` yields
      // '[object Object]', which would make two unrelated rows share a key and
      // silently dedupe them — the same defect lint caught in Task 12's `idOf`.
      if (
        typeof value !== 'string' &&
        typeof value !== 'number' &&
        typeof value !== 'boolean'
      ) {
        throw new Error(`conflict-target column ${col.name} is not a scalar`);
      }
      parts.push(String(value));
    }
    return parts.join(' ');
  }

  const db = {
    insert: () => ({
      values: (values: PriceRow) => ({
        onConflictDoUpdate: ({
          target,
          set,
        }: {
          target: { name: string }[];
          set: Partial<PriceRow>;
        }) => {
          const key = keyFrom(target, values);
          const hit =
            key === null
              ? undefined
              : rows.find((r) => keyFrom(target, r) === key);
          if (hit) {
            Object.assign(hit, set);
          } else {
            rows.push({ ...values });
          }
          return Promise.resolve(undefined);
        },
      }),
    }),
  };

  return { db, rows };
}

/**
 * A stub shaped for `CatalogueService`, which issues `select().from().where()
 * .limit()`. It answers out of the same `rows` array the seed wrote into, so a
 * test that seeds and then resolves is exercising one store, not two.
 */
function catalogueOver(rows: PriceRow[], legacy: Record<string, string> = {}) {
  let captured: { provider: string; planCode: string; itemType: string };
  // The service issues its provider_prices read first, then at most one legacy
  // read. Counting the reads per call is what tells the two apart.
  let read = 0;

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            if (read++ === 0) {
              const hit = rows.find(
                (r) =>
                  r.provider === captured.provider &&
                  r.planCode === captured.planCode &&
                  r.itemType === captured.itemType &&
                  r.isActive,
              );
              return Promise.resolve(
                hit ? [{ providerRef: hit.providerRef }] : [],
              );
            }
            const key = `${captured.planCode}/${captured.itemType}`;
            return Promise.resolve(
              legacy[key] ? [{ stripePriceId: legacy[key] }] : [],
            );
          },
        }),
      }),
    }),
  };

  return {
    resolve(provider: string, planCode: string, itemType: string) {
      captured = { provider, planCode, itemType };
      read = 0;
      return new CatalogueService(db as never).resolveRef(
        provider as never,
        planCode,
        itemType as never,
      );
    },
  };
}

/**
 * Read the `(column, value)` pairs out of a real drizzle where-clause.
 *
 * This exists because the first version of this fake applied `is_active`
 * ITSELF and ignored the clause, which made the service's own
 * `eq(providerPrices.isActive, true)` dead weight: deleting it broke no test.
 * Interpreting the clause is what makes the filter under test the thing that
 * actually filters.
 */
function clausePairs(clause: unknown): { column: string; value: unknown }[] {
  const pairs: { column: string; value: unknown }[] = [];
  let pendingColumn: string | null = null;

  function walk(node: unknown): void {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== 'object') return;

    const n = node as Record<string, unknown>;

    // A drizzle column carries both a snake_case `name` and a `columnType`.
    if (typeof n.name === 'string' && n.columnType !== undefined) {
      pendingColumn = n.name;
      return;
    }
    if (Array.isArray(n.queryChunks)) {
      walk(n.queryChunks);
      return;
    }
    // Drizzle interleaves literal SQL fragments (StringChunk, whose `value`
    // is an array like [' = ']) with bound parameters (Param, whose `value`
    // is the real operand). Only the latter is the value we want; treating a
    // fragment as one is what made the first attempt read [' = '] as the
    // operand and match nothing.
    if (!('value' in n)) return;
    if (Array.isArray(n.value)) return; // a literal SQL fragment
    if (pendingColumn) {
      pairs.push({ column: pendingColumn, value: n.value });
      pendingColumn = null;
    }
  }

  walk(clause);
  return pairs;
}

/** The catalogue tables, for `billableCatalogueKeys` / `missingCatalogueRows`. */
function makeCatalogueDb(
  plansIn: (string | { code: string; basePriceCents: number })[],
  addons: { planCode: string; addonType: string }[],
  prices: PriceRow[] = [],
) {
  const planRows = plansIn.map((p) =>
    typeof p === 'string' ? { code: p, basePriceCents: 1000 } : p,
  );
  let call = 0;
  return {
    select: () => ({
      from: () => ({
        where: (clause: unknown) => {
          const which = call++;
          if (which === 0) return Promise.resolve(planRows);
          if (which === 1) return Promise.resolve(addons);

          // The provider_prices read. Apply the caller's OWN clause rather
          // than a filter written here, so the service's `is_active` and
          // `provider` predicates are load-bearing.
          const pairs = clausePairs(clause);
          const matches = prices.filter((row) =>
            pairs.every(({ column, value }) => {
              if (column === 'provider') return row.provider === value;
              if (column === 'is_active') return row.isActive === value;
              if (column === 'plan_code') return true; // an IN over wanted plans
              if (column === 'item_type') return row.itemType === value;
              return true;
            }),
          );
          return Promise.resolve(
            matches.map((p) => ({
              planCode: p.planCode,
              itemType: p.itemType,
            })),
          );
        },
      }),
    }),
  };
}

/**
 * The invariant, stated once and asserted directly — the shape
 * `expectDefaultInvariant()` established for `provider_subscriptions`.
 *
 * For `provider_prices` it is: for a given provider, every (plan_code,
 * item_type) pair has AT MOST ONE active row; no active row carries a blank
 * `provider_ref`; and no active row carries a null `plan_code`. The first
 * clause is what the unique constraint promises. The second and third are the
 * two ways a row can EXIST and still be useless — a blank ref resolves to `''`
 * and fails inside the provider's API instead of throwing our named error, and
 * a null plan_code can never be read back, because both `resolveRef` call sites
 * pass a real plan code and NULL never equals anything.
 */
function expectPriceInvariant(rows: PriceRow[]): void {
  const active = rows.filter((r) => r.isActive);
  const seen = new Set<string>();

  for (const row of active) {
    expect(row.providerRef).toBeTruthy();
    expect(row.providerRef.trim()).not.toBe('');

    // A null plan_code is unreachable by every reader AND undedupable by the
    // constraint, so it is never a legitimate active row.
    expect(row.planCode).not.toBeNull();

    const key = `${row.provider} ${row.planCode} ${row.itemType}`;
    expect(seen.has(key)).toBe(false);
    seen.add(key);
  }
}

/**
 * Deliberately synthetic variant ids. Nothing in these tests depends on the
 * real numbers, and a committed real id invites someone to copy it into a
 * different environment — where it would be a TEST-mode id pointed at live
 * billing. The real ones live only in `.env`.
 */
const FULL_ENV = {
  LEMONSQUEEZY_VARIANT_BASIC: '1000001',
  LEMONSQUEEZY_VARIANT_PRO: '1000002',
  LEMONSQUEEZY_VARIANT_MAX: '1000003',
  LEMONSQUEEZY_VARIANT_EXTRA_CHANNEL: '1000004',
} as NodeJS.ProcessEnv;

describe('resolvePrices', () => {
  it('resolves all four rows when every variable is set', () => {
    const { resolved, skipped } = resolvePrices(FULL_ENV);

    expect(skipped).toHaveLength(0);
    expect(resolved.map((r) => `${r.planCode}/${r.itemType}`)).toEqual([
      'BASIC/BASE_PLAN',
      'PRO/BASE_PLAN',
      'MAX/BASE_PLAN',
      'PRO/EXTRA_CHANNEL',
    ]);
  });

  it('skips an unset variable instead of writing an empty ref', () => {
    const env = { ...FULL_ENV };
    delete env.LEMONSQUEEZY_VARIANT_MAX;

    const { resolved, skipped } = resolvePrices(env);

    expect(resolved.map((r) => r.planCode)).not.toContain('MAX');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].envVar).toBe('LEMONSQUEEZY_VARIANT_MAX');
  });

  /**
   * The sharper half of the same rule. An empty string is SET, so a naive
   * presence check would let it through — and `provider_ref` is NOT NULL, so
   * the database would happily store it. `resolveRef` then returns `''`, which
   * is falsy, so the service's `if (ref)` guard rejects it and throws "not
   * provisioned" anyway — but only by luck of that one guard. A whitespace ref
   * is truthy and WOULD be returned, reaching the adapter as
   * `variant_id: Number('  ')` = NaN.
   */
  it('skips a blank or whitespace-only variable', () => {
    const env = {
      ...FULL_ENV,
      LEMONSQUEEZY_VARIANT_PRO: '',
      LEMONSQUEEZY_VARIANT_MAX: '   ',
    } as NodeJS.ProcessEnv;

    const { resolved, skipped } = resolvePrices(env);

    expect(resolved.map((r) => `${r.planCode}/${r.itemType}`)).toEqual([
      'BASIC/BASE_PLAN',
      'PRO/EXTRA_CHANNEL',
    ]);
    expect(skipped.map((s) => s.envVar).sort()).toEqual([
      'LEMONSQUEEZY_VARIANT_MAX',
      'LEMONSQUEEZY_VARIANT_PRO',
    ]);
  });

  it('names a real plan code on every planned row, never null', () => {
    // Null is undedupable by the unique constraint and unreachable by every
    // reader; this pins that no future edit introduces one.
    for (const row of LEMONSQUEEZY_PRICES) {
      expect(typeof row.planCode).toBe('string');
      expect(row.planCode.length).toBeGreaterThan(0);
    }
  });
});

describe('upsertProviderPrices', () => {
  it('writes one row per planned entry and holds the invariant', async () => {
    const { db, rows } = makeStore();
    const { resolved } = resolvePrices(FULL_ENV);

    await upsertProviderPrices(resolved, db as never);

    expect(rows).toHaveLength(4);
    expectPriceInvariant(rows);
  });

  /**
   * Re-running the seed is the whole point of it being idempotent, and the
   * invariant is what "idempotent" actually means here: not "it did not
   * crash", but "there is still exactly one row per key".
   */
  it('is re-runnable: a second run adds no rows', async () => {
    const { db, rows } = makeStore();
    const { resolved } = resolvePrices(FULL_ENV);

    await upsertProviderPrices(resolved, db as never);
    await upsertProviderPrices(resolved, db as never);
    await upsertProviderPrices(resolved, db as never);

    expect(rows).toHaveLength(4);
    expectPriceInvariant(rows);
  });

  /**
   * The stale case. A test product recreated in the dashboard gets a NEW
   * variant id; the old row now points at a variant that no longer exists, and
   * a checkout against it fails at Lemon Squeezy. Re-running must MOVE the
   * pointer, not leave the dead one in place beside a new row.
   */
  it('repoints a stale row at the new variant rather than duplicating it', async () => {
    const { db, rows } = makeStore();

    await upsertProviderPrices(resolvePrices(FULL_ENV).resolved, db as never);
    await upsertProviderPrices(
      resolvePrices({
        ...FULL_ENV,
        LEMONSQUEEZY_VARIANT_PRO: '9999999',
      } as NodeJS.ProcessEnv).resolved,
      db as never,
    );

    expect(rows).toHaveLength(4);
    const pro = rows.find(
      (r) => r.planCode === 'PRO' && r.itemType === 'BASE_PLAN',
    );
    expect(pro?.providerRef).toBe('9999999');
    expectPriceInvariant(rows);
  });

  /** A row switched off by hand comes back when it is seeded again. */
  it('reactivates a row that was deactivated', async () => {
    const { db, rows } = makeStore([
      {
        provider: 'lemonsqueezy',
        planCode: 'PRO',
        itemType: 'BASE_PLAN',
        providerRef: '1000002',
        isActive: false,
      },
    ]);

    await upsertProviderPrices(resolvePrices(FULL_ENV).resolved, db as never);

    expect(rows).toHaveLength(4);
    expect(
      rows.find((r) => r.planCode === 'PRO' && r.itemType === 'BASE_PLAN')
        ?.isActive,
    ).toBe(true);
    expectPriceInvariant(rows);
  });

  it('writes nothing when every variable is unset', async () => {
    const { db, rows } = makeStore();
    const { resolved, skipped } = resolvePrices({} as NodeJS.ProcessEnv);

    await upsertProviderPrices(resolved, db as never);

    expect(rows).toHaveLength(0);
    expect(skipped).toHaveLength(4);
    expectPriceInvariant(rows);
  });
});

/**
 * The end-to-end property the seed exists for, asserted through the REAL
 * `CatalogueService` rather than by reading the rows back. This is what
 * separates "the seed wrote a row" from "the adapter can now bill".
 */
describe('what the seed makes resolvable', () => {
  async function seeded(env: NodeJS.ProcessEnv = FULL_ENV) {
    const { db, rows } = makeStore();
    await upsertProviderPrices(resolvePrices(env).resolved, db as never);
    return { rows, catalogue: catalogueOver(rows) };
  }

  it('resolves each seeded plan to the variant id from its env var', async () => {
    const { catalogue } = await seeded();

    await expect(
      catalogue.resolve('lemonsqueezy', 'BASIC', 'BASE_PLAN'),
    ).resolves.toBe('1000001');
    await expect(
      catalogue.resolve('lemonsqueezy', 'PRO', 'BASE_PLAN'),
    ).resolves.toBe('1000002');
    await expect(
      catalogue.resolve('lemonsqueezy', 'MAX', 'BASE_PLAN'),
    ).resolves.toBe('1000003');
    await expect(
      catalogue.resolve('lemonsqueezy', 'PRO', 'EXTRA_CHANNEL'),
    ).resolves.toBe('1000004');
  });

  /**
   * A MISSING row is a clean, named 400 — not a silent wrong branch. This is
   * the answer to "what happens when a row is absent", proven rather than
   * asserted in a comment. EXTRA_MEMBER has no Lemon Squeezy product yet, so
   * this is the real state of the catalogue today, not a hypothetical.
   */
  it('throws a named error for an item with no Lemon Squeezy product', async () => {
    const { catalogue } = await seeded();

    await expect(
      catalogue.resolve('lemonsqueezy', 'PRO', 'EXTRA_MEMBER'),
    ).rejects.toThrow(/lemonsqueezy.*PRO.*EXTRA_MEMBER.*not provisioned/is);
  });

  /**
   * A row seeded for PRO must NOT answer for BASIC. The add-on path resolves
   * with the account's own plan code, so a scope-blind lookup would sell a
   * BASIC customer the PRO-priced channel.
   */
  it('does not answer an add-on lookup for a different plan', async () => {
    const { catalogue } = await seeded();

    await expect(
      catalogue.resolve('lemonsqueezy', 'BASIC', 'EXTRA_CHANNEL'),
    ).rejects.toThrow(/not provisioned/i);
  });

  /**
   * Seeding Lemon Squeezy must not make Stripe resolvable. The two providers
   * bill different accounts; a cross-provider read would send a Lemon Squeezy
   * variant id to Stripe.
   */
  it('leaves Stripe unresolvable — a variant id is not a price id', async () => {
    const { catalogue } = await seeded();

    await expect(
      catalogue.resolve('stripe', 'PRO', 'BASE_PLAN'),
    ).rejects.toThrow(/not provisioned/i);
  });

  /** A skipped row stays a clean error, never a blank ref sent to the API. */
  it('a skipped variable leaves that plan throwing, not resolving to blank', async () => {
    const env = { ...FULL_ENV, LEMONSQUEEZY_VARIANT_MAX: '' };
    const { catalogue } = await seeded(env as NodeJS.ProcessEnv);

    await expect(
      catalogue.resolve('lemonsqueezy', 'MAX', 'BASE_PLAN'),
    ).rejects.toThrow(/not provisioned/i);
  });
});

describe('missingCatalogueRows', () => {
  it('names every billable pair with no lemonsqueezy price', async () => {
    const db = makeCatalogueDb(
      ['BASIC', 'PRO'],
      [
        { planCode: 'PRO', addonType: 'EXTRA_CHANNEL' },
        { planCode: 'PRO', addonType: 'EXTRA_MEMBER' },
      ],
      [
        {
          provider: 'lemonsqueezy',
          planCode: 'PRO',
          itemType: 'BASE_PLAN',
          providerRef: '1000002',
          isActive: true,
        },
        {
          provider: 'lemonsqueezy',
          planCode: 'PRO',
          itemType: 'EXTRA_CHANNEL',
          providerRef: '1000004',
          isActive: true,
        },
      ],
    );

    const missing = await missingCatalogueRows('lemonsqueezy', db as never);

    expect(missing.map((m) => `${m.planCode}/${m.itemType}`).sort()).toEqual([
      'BASIC/BASE_PLAN',
      'PRO/EXTRA_MEMBER',
    ]);
  });

  it('reports nothing missing when the catalogue is fully covered', async () => {
    const db = makeCatalogueDb(
      ['PRO'],
      [{ planCode: 'PRO', addonType: 'EXTRA_CHANNEL' }],
      [
        {
          provider: 'lemonsqueezy',
          planCode: 'PRO',
          itemType: 'BASE_PLAN',
          providerRef: '1000002',
          isActive: true,
        },
        {
          provider: 'lemonsqueezy',
          planCode: 'PRO',
          itemType: 'EXTRA_CHANNEL',
          providerRef: '1000004',
          isActive: true,
        },
      ],
    );

    await expect(
      missingCatalogueRows('lemonsqueezy', db as never),
    ).resolves.toEqual([]);
  });

  /**
   * A STRIPE row is not Lemon Squeezy coverage. Stripe already has rows for
   * every plan and add-on (that is what the legacy `stripe_price_id` columns
   * are), so a provider-blind gap query would report Lemon Squeezy as fully
   * covered while it can actually sell nothing — the cross-provider leak this
   * whole branch exists to prevent, in report form.
   */
  it('does not count a Stripe row as lemonsqueezy coverage', async () => {
    const db = makeCatalogueDb(
      ['PRO'],
      [{ planCode: 'PRO', addonType: 'EXTRA_CHANNEL' }],
      [
        {
          provider: 'stripe',
          planCode: 'PRO',
          itemType: 'BASE_PLAN',
          providerRef: 'price_stripe_pro',
          isActive: true,
        },
        {
          provider: 'stripe',
          planCode: 'PRO',
          itemType: 'EXTRA_CHANNEL',
          providerRef: 'price_stripe_chan',
          isActive: true,
        },
      ],
    );

    const missing = await missingCatalogueRows('lemonsqueezy', db as never);

    expect(missing.map((m) => `${m.planCode}/${m.itemType}`).sort()).toEqual([
      'PRO/BASE_PLAN',
      'PRO/EXTRA_CHANNEL',
    ]);
  });

  /**
   * An INACTIVE row does not count as coverage. `resolveRef` filters on
   * `is_active`, so a deactivated row throws exactly like an absent one — and
   * a gap report that counted it would say "fully covered" about a catalogue
   * that 400s.
   */
  it('counts a deactivated row as missing, matching what resolveRef does', async () => {
    const rows: PriceRow[] = [
      {
        provider: 'lemonsqueezy',
        planCode: 'PRO',
        itemType: 'BASE_PLAN',
        providerRef: '1000002',
        isActive: false,
      },
    ];
    const db = makeCatalogueDb(['PRO'], [], rows);

    const missing = await missingCatalogueRows('lemonsqueezy', db as never);
    expect(missing.map((m) => `${m.planCode}/${m.itemType}`)).toEqual([
      'PRO/BASE_PLAN',
    ]);

    // And the resolver agrees, which is the point of the assertion above.
    await expect(
      catalogueOver(rows).resolve('lemonsqueezy', 'PRO', 'BASE_PLAN'),
    ).rejects.toThrow(/not provisioned/i);
  });
});

describe('billableCatalogueKeys', () => {
  it('derives the pairs from the catalogue tables, not from a restated list', async () => {
    const db = makeCatalogueDb(
      ['BASIC', 'PRO'],
      [
        { planCode: 'BASIC', addonType: 'EXTRA_CHANNEL' },
        { planCode: 'PRO', addonType: 'EXTRA_AI_TOKENS' },
      ],
    );

    const keys = await billableCatalogueKeys(db as never);

    expect(keys.map((k) => `${k.planCode}/${k.itemType}`).sort()).toEqual([
      'BASIC/BASE_PLAN',
      'BASIC/EXTRA_CHANNEL',
      'PRO/BASE_PLAN',
      'PRO/EXTRA_AI_TOKENS',
    ]);
  });

  /**
   * FREE is not a gap, because no code path can reach `resolveRef` with it:
   * `subscription.service.ts` throws "FREE plan does not require checkout" on
   * `basePriceCents <= 0` before calling the adapter, and
   * `plan-change.service.ts` routes `newPlanCode === 'FREE'` into
   * `downgradeToFree`. Reporting it would be noise in a report whose only
   * value is that every line is a real defect.
   */
  it('excludes a zero-priced plan, which no checkout path can reach', async () => {
    const db = makeCatalogueDb(
      [
        { code: 'FREE', basePriceCents: 0 },
        { code: 'PRO', basePriceCents: 1000 },
      ],
      [],
    );

    const keys = await billableCatalogueKeys(db as never);

    expect(keys.map((k) => k.planCode)).toEqual(['PRO']);
  });
});

describe('the seeded set against the real add-on catalogue', () => {
  /**
   * The gap the brief asks to record, stated as a test so it cannot be
   * forgotten silently: of the add-on types the app sells, Lemon Squeezy can
   * price exactly one today. When someone creates the other three products and
   * adds their variant ids, this test fails and points at the ledger entry.
   */
  it('covers EXTRA_CHANNEL only, of the four add-on types', () => {
    const ADDON_TYPES: ProviderItemType[] = [
      'EXTRA_CHANNEL',
      'EXTRA_MEMBER',
      'EXTRA_WORKSPACE',
      'EXTRA_AI_TOKENS',
    ];

    const covered = new Set(
      LEMONSQUEEZY_PRICES.filter((p) => p.itemType !== 'BASE_PLAN').map(
        (p) => p.itemType,
      ),
    );

    expect([...covered]).toEqual(['EXTRA_CHANNEL']);
    expect(ADDON_TYPES.filter((t) => !covered.has(t))).toEqual([
      'EXTRA_MEMBER',
      'EXTRA_WORKSPACE',
      'EXTRA_AI_TOKENS',
    ]);
  });

  /**
   * The half the brief's gap note missed, and the reason the seed prints its
   * report from the catalogue tables instead of trusting a written list.
   *
   * `addon_pricing` prices EXTRA_CHANNEL SEPARATELY for BASIC, PRO and MAX —
   * three rows, three different `price_per_unit_cents` — and
   * `LemonSqueezyAdapter.purchaseAddon` resolves with the ACCOUNT's own plan
   * code. So the single seeded PRO row serves PRO customers only. A BASIC or
   * MAX customer buying an extra channel gets "not provisioned", exactly like
   * the three add-on types that have no product at all. Three Lemon Squeezy
   * products are needed for EXTRA_CHANNEL, not one.
   */
  it('covers EXTRA_CHANNEL for PRO only — BASIC and MAX are still gaps', () => {
    const channelPlans = LEMONSQUEEZY_PRICES.filter(
      (p) => p.itemType === 'EXTRA_CHANNEL',
    ).map((p) => p.planCode);

    expect(channelPlans).toEqual(['PRO']);
    expect(channelPlans).not.toContain('BASIC');
    expect(channelPlans).not.toContain('MAX');
  });

  it('covers every paid plan, so no signup can hit a missing base plan', () => {
    const basePlans = LEMONSQUEEZY_PRICES.filter(
      (p) => p.itemType === 'BASE_PLAN',
    ).map((p) => p.planCode);

    // FREE is deliberately absent: base_price_cents is 0, so no checkout for it.
    expect(basePlans.sort()).toEqual(['BASIC', 'MAX', 'PRO']);
  });
});

/** Keeps the exported type referenced, so a rename cannot silently drift. */
const _typecheck: ResolvedPrice = {
  provider: 'lemonsqueezy',
  planCode: 'PRO',
  itemType: 'BASE_PLAN',
  envVar: 'LEMONSQUEEZY_VARIANT_PRO',
  providerRef: '1000002',
};
void _typecheck;
