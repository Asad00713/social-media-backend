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

export type Predicate = (row: Row) => boolean;

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

/** Depth-first flatten of drizzle's nested `queryChunks`. */
function flatten(chunks: unknown[], out: unknown[] = []): unknown[] {
  for (const chunk of chunks) {
    const nested = (chunk as any)?.queryChunks as unknown[] | undefined;
    if (Array.isArray(nested)) flatten(nested, out);
    else out.push(chunk);
  }
  return out;
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

  const pairs: { column: string; value: unknown }[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk: any = chunks[i];
    if (chunk && typeof chunk === 'object' && typeof chunk.name === 'string') {
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
          Promise.resolve(
            rowsOf(target)
              .filter(match)
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
