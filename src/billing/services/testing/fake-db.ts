/**
 * A table-aware fake of drizzle's query builders, for the webhook specs.
 *
 * Lifted verbatim out of `lemonsqueezy-webhook.service.spec.ts`, where it had
 * already been copied into three spec files, so the Paddle webhook spec does
 * not make a fourth. Behaviour is unchanged — the Lemon Squeezy spec's 69
 * tests are the guard on the move.
 *
 * WHY IT IS THIS ELABORATE. The recurring defect in this area is state that
 * something READS but nothing reliably WRITES. A fake that cannot catch a
 * write/read mismatch cannot test for it, so this one:
 *
 * - is keyed by TABLE, so a write is visible to a later select, and an add-on
 *   event cannot appear to update the base plan;
 * - honours the `where`, built from drizzle's real `queryChunks`, because
 *   every routing decision in a webhook service is a where clause;
 * - honours the `select` PROJECTION, because the services alias columns
 *   (`{ rowId: providerSubscriptions.id }`) and read the alias back — a fake
 *   returning whole rows hands back `undefined` for every aliased field;
 * - honours the declared CONFLICT TARGET, because a fake that ignores
 *   `onConflictDoUpdate` makes an insert and an upsert indistinguishable, so
 *   "the second delivery updates rather than duplicating" passes with the
 *   upsert deleted.
 *
 * It THROWS on a clause it does not understand rather than matching
 * everything. A fake that silently widens is how a mutation check ends up
 * testing nothing.
 */

/* The fakes stand in for drizzle's fluent builders, whose chain types are not
   expressible here — `any` is deliberate and confined to this file. */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Row {
  [column: string]: unknown;
}

/**
 * `joined` is the row from the joined table, present only while a join
 * condition is being evaluated.
 */
export type Predicate = (row: Row, joined?: Row) => boolean;

/** table name -> rows. The whole database, for one test. */
export interface FakeStore {
  tables: Record<string, Row[]>;
  /** Replace the contents, between tests. */
  reset(seed?: Record<string, Row[]>): void;
  rowsOf(name: string): Row[];
}

/** camelCase property for a snake_case SQL column. */
export function camel(sqlName: string): string {
  return sqlName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Which table a drizzle table object refers to. Drizzle hangs the SQL name off
 * a symbol; reading it is what makes this fake table-AWARE.
 */
export function tableName(t: unknown): string {
  const sym = Object.getOwnPropertySymbols(t as object).find((s) =>
    String(s).includes('Name'),
  );
  const name = sym ? (t as any)[sym] : undefined;
  return typeof name === 'string' ? name : 'unknown';
}

/**
 * Whether a chunk is a drizzle COLUMN rather than a bound value. Columns
 * carry both a SQL `name` and the `table` they belong to; a `Param` carries
 * neither.
 */
function isColumn(chunk: unknown): chunk is { name: string; table: unknown } {
  return Boolean(
    chunk &&
      typeof chunk === 'object' &&
      typeof (chunk as any).name === 'string' &&
      (chunk as any).table,
  );
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

/** The order comparisons `predicateFrom` understands. */
type Ordering = '>' | '>=' | '<' | '<=';

/**
 * A value an order comparison can use. Dates and the ISO strings drizzle
 * binds for a timestamp column both become epoch milliseconds, so a Date in a
 * seed row compares correctly against the string the query bound.
 */
function scalarOf(value: unknown): number | string | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const asDate = Date.parse(value);
    return Number.isNaN(asDate) ? value : asDate;
  }
  return null;
}

/**
 * A REAL predicate, built by walking drizzle's `queryChunks`.
 *
 * `eq(column, value)` serialises to chunks `['', {name}, ' = ', value, '']`,
 * and `and(...)` NESTS those inside its own chunks, so the walk is recursive.
 * Flattening yields the column/value pairs, which is all these services ever
 * build.
 */
export function predicateFrom(condition: unknown): Predicate {
  if (!condition) return () => true;
  const top = (condition as any).queryChunks as unknown[] | undefined;
  if (!Array.isArray(top)) {
    throw new Error('The db fake only understands drizzle eq()/and() clauses.');
  }

  const chunks = flatten(top);

  const pairs: {
    column: string;
    value: unknown;
    nullCheck?: 'is' | 'not';
    oneOf?: unknown[];
    /** `gt`/`gte`/`lt`/`lte`: compare by order, not equality. */
    compare?: { op: Ordering; bound: unknown };
    /** `eq(a.col, b.col)`: the JOINED row's column this must equal. */
    joinsTo?: string;
  }[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk: any = chunks[i];
    if (chunk && typeof chunk === 'object' && typeof chunk.name === 'string') {
      const op = chunks[i + 1] as any;
      const opText = Array.isArray(op?.value) ? String(op.value[0]) : '';

      // `isNull(col)` / `isNotNull(col)` serialise the whole comparison into
      // the operator chunk and bind NO value, so they take no third chunk.
      // The soft-delete helpers (`liveWorkspaces()`, `liveChannel()`) are
      // built from these, so a fake that cannot read them cannot exercise any
      // query that excludes deleted rows.
      if (opText.includes('is not null')) {
        pairs.push({ column: camel(chunk.name), value: null, nullCheck: 'not' });
        i += 1;
        continue;
      }
      if (opText.includes('is null')) {
        pairs.push({ column: camel(chunk.name), value: null, nullCheck: 'is' });
        i += 1;
        continue;
      }

      // `inArray(col, [a, b])` serialises its list as a raw ARRAY OF PARAMS
      // in the chunk stream — not as one Param whose value is the array, the
      // way `eq` binds a single value. Reading `.value` off the array itself
      // yields `undefined`, so `oneOf` became `[undefined]` and the clause
      // matched nothing: every `inArray` query silently returned no rows.
      // The three callers that had one were all DELETEs and UPDATEs whose
      // "no rows matched" nothing asserted, which is why it went unnoticed.
      if (opText.includes(' in ')) {
        const bound = chunks[i + 2];
        const list = Array.isArray(bound) ? bound : [bound];
        pairs.push({
          column: camel(chunk.name),
          value: null,
          oneOf: list.map((entry) =>
            entry && typeof entry === 'object' && 'value' in entry
              ? entry.value
              : entry,
          ),
        });
        i += 2;
        continue;
      }

      // `gt`/`gte`/`lt`/`lte` bind a value like `eq` but compare by ORDER, and
      // the operator text of `<=` and `>=` CONTAINS '=' — so without this
      // branch the equality check below would swallow them and match only an
      // exact hit. A date window built from `gt`/`lte` would then select
      // nothing, and widening it would be untestable.
      //
      // Drizzle maps a timestamp column's bound value through its own
      // serialiser, so the Param here holds an ISO STRING even though the
      // caller passed a Date. Both sides are coerced to a number before
      // comparing.
      const ordering = [' >= ', ' <= ', ' > ', ' < '].find((o) =>
        opText.includes(o),
      );
      if (ordering) {
        const param = chunks[i + 2] as any;
        const bound =
          param && typeof param === 'object' && 'value' in param
            ? param.value
            : param;
        pairs.push({
          column: camel(chunk.name),
          value: null,
          compare: { op: ordering.trim() as Ordering, bound },
        });
        i += 2;
        continue;
      }

      if (!opText.includes('=')) {
        throw new Error(`The db fake only understands '=', saw "${opText}".`);
      }
      const param = chunks[i + 2] as any;

      // `eq(a.col, b.col)` puts a COLUMN in the value slot, where every other
      // comparison puts a bound Param. That is how a join condition is
      // written, so it is recorded as a column pair rather than a literal —
      // treating it as one would compare a row's value against a drizzle
      // column object and match nothing.
      if (isColumn(param)) {
        pairs.push({
          column: camel(chunk.name),
          value: null,
          joinsTo: camel(param.name),
        });
        i += 2;
        continue;
      }

      // The bound value is a drizzle `Param`, not the raw literal.
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

  return (row: Row, joined?: Row) =>
    pairs.every((p) => {
      // Which SIDE a column belongs to is not recorded in the chunk stream —
      // drizzle writes a bare column name and lets SQL resolve it. A join's
      // ON clause mixes the two freely (`provider_subscriptions.provider` and
      // `subscriptions.id` in one `and()`), so each column is read from
      // whichever side actually carries it, with the FROM row preferred.
      const sideOf = (column: string): Row =>
        joined && !(column in row) && column in joined ? joined : row;
      const actual = sideOf(p.column)[p.column];

      // A join condition: `eq(a.col, b.col)`. The two columns live on
      // opposite sides, and which side is which is not knowable from the
      // chunks, so both are resolved the same way as any other column.
      if (p.joinsTo !== undefined) {
        if (!joined) return false;
        return actual === sideOf(p.joinsTo)[p.joinsTo];
      }

      // A null check asks only about presence. A seed row that omits the
      // column entirely counts as NULL, which is what a fresh row is in
      // Postgres too — otherwise every fixture would have to spell out
      // `deletedAt: null` to be seen as live.
      if (p.nullCheck === 'is') return actual === null || actual === undefined;
      if (p.nullCheck === 'not') return actual !== null && actual !== undefined;

      // An order comparison. A missing column is NULL in Postgres and NULL
      // compares to nothing, so an absent value matches neither bound.
      if (p.compare) {
        if (actual === null || actual === undefined) return false;
        const left = scalarOf(actual);
        const right = scalarOf(p.compare.bound);
        if (left === null || right === null) return false;
        switch (p.compare.op) {
          case '>':
            return left > right;
          case '>=':
            return left >= right;
          case '<':
            return left < right;
          default:
            return left <= right;
        }
      }

      // Membership, for `inArray`. Ids arrive as numbers or strings, so
      // compare loosely the way the equality branch below does.
      if (p.oneOf) return p.oneOf.some((v) => v === actual);

      // Dates compare by value; ids arrive as numbers or strings.
      if (actual instanceof Date && p.value instanceof Date) {
        return actual.getTime() === p.value.getTime();
      }
      return actual === p.value;
    });
}

function projectWith(
  projection: Record<string, unknown> | undefined,
  row: Row,
): Row {
  if (!projection) return row;
  const out: Row = {};
  for (const [alias, column] of Object.entries(projection)) {
    const name = (column as any)?.name;
    out[alias] = typeof name === 'string' ? row[camel(name)] : undefined;
  }
  return out;
}

/**
 * The store and the fake `db` that reads and writes it.
 *
 * Returned together so a spec can seed rows and then assert on the RESULTING
 * STATE, which is what these tests are for — never on a function having been
 * called.
 */
export function makeFakeDb(): { store: FakeStore; db: any } {
  let tables: Record<string, Row[]> = {};

  const rowsOf = (name: string): Row[] => {
    tables[name] = tables[name] ?? [];
    return tables[name];
  };

  const store: FakeStore = {
    get tables() {
      return tables;
    },
    reset(seed?: Record<string, Row[]>) {
      tables = seed ?? {};
    },
    rowsOf,
  };

  const db: any = {
    select: (projection?: Record<string, unknown>) => {
      let target = 'unknown';
      let match: Predicate = () => true;
      const joins: { table: string; on: Predicate; inner: boolean }[] = [];

      /**
       * The rows the FROM table contributes, after the joins.
       *
       * A join is evaluated the way SQL does: one output row per MATCHING
       * pair. That matters because the multiplication is the behaviour worth
       * testing — a subscription holding a BASE_PLAN row at two providers
       * comes back TWICE through an inner join, which is how the same
       * customer gets handed the same email twice. A fake whose `innerJoin`
       * was a no-op (this one, until 2026-11-26) reports one row either way,
       * so it passes whether the service joins or not and the duplicate is
       * invisible.
       *
       * Only the FROM row is projected. These specs never select a column
       * off the joined table, and guessing which table an aliased column
       * belongs to would be the kind of silent widening this fake refuses
       * everywhere else.
       */
      const joined = (): Row[] => {
        let rows = rowsOf(target);
        for (const join of joins) {
          const next: Row[] = [];
          for (const row of rows) {
            const partners = rowsOf(join.table).filter((other) =>
              join.on(row, other),
            );
            // One output row per matching partner: that repetition IS the
            // multiplication. A left join with no partner keeps the row once;
            // an inner join drops it.
            if (partners.length === 0) {
              if (!join.inner) next.push(row);
              continue;
            }
            for (let k = 0; k < partners.length; k++) next.push(row);
          }
          rows = next;
        }
        return rows;
      };

      const chain: any = {
        from: (t: unknown) => {
          target = tableName(t);
          return chain;
        },
        innerJoin: (t: unknown, on: unknown) => {
          joins.push({
            table: tableName(t),
            on: predicateFrom(on),
            inner: true,
          });
          return chain;
        },
        leftJoin: (t: unknown, on: unknown) => {
          joins.push({
            table: tableName(t),
            on: predicateFrom(on),
            inner: false,
          });
          return chain;
        },
        where: (c: unknown) => {
          match = predicateFrom(c);
          return chain;
        },
        orderBy: () => chain,
        limit: () => chain,
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(
            joined()
              .filter((row) => match(row))
              .map((r) => projectWith(projection, r)),
          ).then(resolve),
      };
      return chain;
    },

    insert: (t: unknown) => {
      const target = tableName(t);
      let last: Row[] = [];
      let pending: Row[] = [];
      const chain: any = {
        values: (v: Row | Row[]) => {
          pending = Array.isArray(v) ? v : [v];
          last = [];
          for (const row of pending) {
            const stored = { id: rowsOf(target).length + 1, ...row };
            rowsOf(target).push(stored);
            last.push(stored);
          }
          return chain;
        },
        onConflictDoUpdate: (arg: {
          target: unknown[];
          set: Record<string, unknown>;
        }) => {
          const keys = (arg.target ?? []).map((c) =>
            camel(String((c as any)?.name)),
          );
          if (keys.length === 0) {
            throw new Error('The db fake needs a declared conflict target.');
          }
          // Undo the optimistic append and redo it as a real upsert.
          last = [];
          for (let k = 0; k < pending.length; k++) rowsOf(target).pop();
          for (const row of pending) {
            const existing = rowsOf(target).find((r) =>
              keys.every((k) => r[k] === row[k]),
            );
            if (existing) {
              Object.assign(existing, arg.set);
              last.push(existing);
            } else {
              const stored = { id: rowsOf(target).length + 1, ...row };
              rowsOf(target).push(stored);
              last.push(stored);
            }
          }
          return chain;
        },
        onConflictDoNothing: () => chain,
        returning: (projection?: Record<string, unknown>) =>
          Promise.resolve(last.map((r) => projectWith(projection, r))),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(last).then(resolve),
      };
      return chain;
    },

    update: (t: unknown) => {
      const target = tableName(t);
      let patch: Row = {};
      let match: Predicate = () => true;
      let matched: Row[] = [];
      // Match and patch in ONE synchronous step, as a single UPDATE statement
      // does: a conditional update can then be won by exactly one of two
      // concurrent callers.
      const apply = (): void => {
        matched = rowsOf(target).filter((row) => match(row));
        for (const row of matched) Object.assign(row, patch);
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
        returning: (projection?: Record<string, unknown>) =>
          Promise.resolve(matched.map((r) => projectWith(projection, r))),
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

  return { store, db };
}
