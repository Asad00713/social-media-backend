import { readFileSync } from 'fs';
import { join } from 'path';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  buildAliasedSearchCondition,
  buildAliasedStatusCondition,
  buildSearchCondition,
  decodeThreadCursor,
  decodeThreadKey,
  deriveThreadStatusFromItems,
  encodeThreadCursor,
  escapeLikePattern,
  folderToStatuses,
  normalizeSearchQuery,
  searchCaptionSql,
  searchHaystackSql,
} from './inbox-search.helpers';

const dialect = new PgDialect();

/** Render a Drizzle SQL fragment to the text Postgres would actually receive. */
function render(fragment: SQL): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(fragment);
  return { sql: query.sql, params: query.params };
}

/** Strip the table qualifier and quoting Drizzle adds, so the expression can be
 *  compared against the column names as written in the migration. */
function unqualify(sqlText: string): string {
  return sqlText.replace(/"inbox_items"\./g, '').replace(/"/g, '');
}

// These are pure functions of their arguments, exported specifically so they
// can be tested without the query-builder mocking ceremony that anything
// touching the `db` singleton requires (see `inbox.service.hide.spec.ts`).

describe('escapeLikePattern', () => {
  // The discriminating case: `%` is a LIKE wildcard, so an unescaped query of
  // "50%" matches every row in the table rather than the rows containing "50%".
  it('escapes a percent sign so it matches literally instead of matching everything', () => {
    expect(escapeLikePattern('50%')).toBe('50\\%');
  });

  it('escapes an underscore so it matches literally instead of any single character', () => {
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
  });

  // Backslash has to be escaped first, or escaping the others would produce
  // backslashes that then get double-escaped.
  it('escapes a backslash without corrupting the escapes it introduces', () => {
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeLikePattern('hello world')).toBe('hello world');
  });
});

describe('normalizeSearchQuery', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeSearchQuery('  refund  ')).toBe('refund');
  });

  // A single character matches most rows and the trigram index cannot serve it,
  // so it is treated as no search rather than as a table scan.
  it('ignores a one-character query', () => {
    expect(normalizeSearchQuery('a')).toBeUndefined();
  });

  it('ignores a query that is only whitespace', () => {
    expect(normalizeSearchQuery('   ')).toBeUndefined();
  });

  it('ignores an absent query', () => {
    expect(normalizeSearchQuery(undefined)).toBeUndefined();
  });

  it('accepts a two-character query', () => {
    expect(normalizeSearchQuery('hi')).toBe('hi');
  });
});

describe('buildSearchCondition', () => {
  it('binds the query as an escaped, wildcard-wrapped parameter', () => {
    const { params } = render(buildSearchCondition('50%'));
    // Every bound parameter is the same needle — one for the haystack, one for
    // the caption. The `%` is escaped, so this matches rows containing "50%"
    // rather than every row in the table.
    expect(params).toEqual(['%50\\%%', '%50\\%%']);
  });

  it('lowercases the needle so the match is case-insensitive', () => {
    const { params } = render(buildSearchCondition('ReFuNd'));
    expect(params).toEqual(['%refund%', '%refund%']);
  });

  // Parameters, never interpolation — a query containing a quote must not be
  // able to terminate the string literal.
  it('never inlines the query into the SQL text', () => {
    const { sql } = render(buildSearchCondition("'; DROP TABLE inbox_items--"));
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).toContain('$1');
  });

  // ESCAPE has to be declared or the backslashes the escaper emits are treated
  // as literal characters rather than as escapes.
  it('declares the escape character LIKE should honour', () => {
    const { sql } = render(buildSearchCondition('x'));
    expect(sql).toContain("ESCAPE '\\'");
  });
});

/**
 * The aggregate listings are raw SQL over `FROM inbox_items i`. Postgres treats
 * an alias as shadowing the table name, so a fully-qualified
 * `"inbox_items"."text"` inside that query is an "invalid reference to
 * FROM-clause entry" — a 500 on every search, which is exactly how this shipped
 * the first time. A mocked-db unit test cannot see it, so these assert the
 * rendered text directly.
 */
describe('buildAliasedSearchCondition', () => {
  it('references the alias, never the table name', () => {
    const { sql } = render(buildAliasedSearchCondition('refund', 'i'));
    expect(sql).toContain('i.text');
    expect(sql).toContain('i.author_handle');
    expect(sql).toContain('i.author_display_name');
    expect(sql).not.toContain('inbox_items');
  });

  it('binds the query the same way the unaliased predicate does', () => {
    expect(render(buildAliasedSearchCondition('50%', 'i')).params).toEqual(
      render(buildSearchCondition('50%')).params,
    );
  });

  // Both forms have to stay interchangeable, or the trigram index serves one
  // call site and not the other.
  it('renders the same expression as the unaliased predicate once the qualifier is normalised', () => {
    const aliased = render(buildAliasedSearchCondition('x', 'i')).sql;
    const plain = unqualify(render(buildSearchCondition('x')).sql);
    expect(aliased.replace(/\bi\./g, '')).toBe(plain);
  });
});

/**
 * `= ANY(${statuses})` looks right and is not: Drizzle unwraps a single-element
 * array into a scalar parameter, so Postgres receives `'unread'` where it wants
 * `{unread}` and fails with "malformed array literal". Every folder filter was
 * a 500 because of it — and, like the alias bug, a mocked-db test cannot see it.
 */
describe('buildAliasedStatusCondition', () => {
  it('binds each status as its own parameter rather than one array', () => {
    const { sql, params } = render(
      buildAliasedStatusCondition(['unread'], 'i'),
    );
    expect(params).toEqual(['unread']);
    // An IN list, which survives the single-element case.
    expect(sql).toContain('i.status IN ($1)');
    expect(sql).not.toContain('ANY');
  });

  it('keeps every status when several are given', () => {
    const { params } = render(
      buildAliasedStatusCondition(['needs_reply', 'replied', 'done'], 'i'),
    );
    expect(params).toEqual(['needs_reply', 'replied', 'done']);
  });

  it('references the alias, never the table name', () => {
    const { sql } = render(buildAliasedStatusCondition(['done'], 'i'));
    expect(sql).toContain('i.status');
    expect(sql).not.toContain('inbox_items');
  });
});

/**
 * The tests above prove the aliased helper is correct. They do NOT prove the
 * aggregate queries call it — and calling the wrong one is precisely the bug
 * that shipped: `listCommentThreads` and `listDmConversations` used the
 * unaliased predicate inside `FROM inbox_items i`, so every search 500'd.
 *
 * Nothing reachable from a unit test executes that SQL, so this reads the
 * source and asserts the call. Crude, but it is the only thing standing between
 * a one-word edit and a broken search endpoint.
 */
describe('the aggregate listings use the aliased predicate', () => {
  const service = readFileSync(join(__dirname, 'inbox.service.ts'), 'utf8');

  it('builds its CTE search predicates against the table alias', () => {
    const aliasedCalls = service.match(
      /buildAliasedSearchCondition\(search, 'i'\)/g,
    );
    // One for comments, one for DMs.
    expect(aliasedCalls).toHaveLength(2);
  });

  it('never drops the unaliased predicate into a bool_or aggregate', () => {
    // `bool_or(...)` only appears inside the aggregate CTEs, where the table is
    // aliased. The unaliased helper there is the FROM-clause error.
    expect(service).not.toContain('bool_or(${buildSearchCondition(search)})');
  });

  it('filters folders with the IN-list helper, not a bare ANY()', () => {
    const statusCalls = service.match(
      /buildAliasedStatusCondition\(statuses, 'i'\)/g,
    );
    expect(statusCalls).toHaveLength(2);
    // `= ANY(${array})` is the shape that 500s on a single-element filter.
    expect(service).not.toContain('ANY(${statuses})');
  });
});

// This is the test that stops inbox search silently degrading to a sequential
// scan. Postgres matches expression indexes STRUCTURALLY: if the expression in
// the query is not identical to the one in the index, the planner ignores the
// index without any error. Nothing at runtime would tell us — search would just
// get slower as the table grows. So we assert the SQL we generate and the SQL
// the migration indexes are the same text.
describe('search expressions match the indexes in migration 0036', () => {
  const migration = readFileSync(
    join(__dirname, '../../drizzle/migrations/0036_inbox_search_indexes.sql'),
    'utf8',
  );

  /** Collapse all whitespace so formatting differences do not fail the test. */
  function normalize(sqlText: string): string {
    return sqlText.replace(/\s+/g, ' ').trim();
  }

  const normalizedMigration = normalize(migration);

  // Renders the expression the query ACTUALLY builds and looks for that exact
  // text in the migration, rather than asserting against a hand-copied string
  // that could drift from both.
  it('indexes the same haystack expression the query builds', () => {
    const built = normalize(unqualify(render(searchHaystackSql()).sql));
    // Strip the outer parens the fragment carries; the index expression is
    // wrapped by CREATE INDEX's own parentheses instead.
    const inner = built.replace(/^\(/, '').replace(/\)$/, '');
    expect(normalizedMigration).toContain(inner);
  });

  it('indexes the same caption expression the query builds', () => {
    const built = normalize(unqualify(render(searchCaptionSql()).sql));
    expect(normalizedMigration).toContain(built);
  });

  it('creates the trigram extension the indexes depend on', () => {
    expect(migration).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  });

  // CREATE INDEX CONCURRENTLY cannot run inside a transaction block. A stray
  // BEGIN; here would make every index build fail on the target database.
  it('does not wrap the concurrent index builds in a transaction', () => {
    expect(migration).not.toMatch(/^\s*BEGIN;/m);
  });
});

describe('folderToStatuses', () => {
  it('applies no status filter for the all folder', () => {
    expect(folderToStatuses('all')).toBeUndefined();
  });

  it('applies no status filter when no folder is given', () => {
    expect(folderToStatuses(undefined)).toBeUndefined();
  });

  // The regression this fixes: `replied` used to map to nothing, so answering a
  // conversation removed it from every folder except `all`.
  it('maps the replied folder to the replied status instead of dropping it', () => {
    expect(folderToStatuses('replied')).toEqual(['replied']);
  });

  it('maps unread, needs_reply and done to their statuses', () => {
    expect(folderToStatuses('unread')).toEqual(['unread']);
    expect(folderToStatuses('needs_reply')).toEqual(['needs_reply']);
    expect(folderToStatuses('done')).toEqual(['done']);
  });

  it('lets an explicit status override the folder', () => {
    expect(folderToStatuses('unread', 'done')).toEqual(['done']);
  });

  it('lets an explicit status apply even against the all folder', () => {
    expect(folderToStatuses('all', 'replied')).toEqual(['replied']);
  });
});

describe('deriveThreadStatusFromItems', () => {
  it('reports unread when an incoming item is unread', () => {
    expect(
      deriveThreadStatusFromItems([
        { status: 'unread', fromMe: false },
        { status: 'replied', fromMe: true },
      ]),
    ).toBe('unread');
  });

  // The discriminating case. An unread flag on a row WE sent is not something
  // the user has to read, so it must not colour the thread unread — the
  // needs_reply row behind it is what matters.
  it('ignores an unread item we sent ourselves and falls through to needs_reply', () => {
    expect(
      deriveThreadStatusFromItems([
        { status: 'unread', fromMe: true },
        { status: 'needs_reply', fromMe: false },
      ]),
    ).toBe('needs_reply');
  });

  it('reports done only when every item is done', () => {
    expect(
      deriveThreadStatusFromItems([
        { status: 'done', fromMe: false },
        { status: 'done', fromMe: true },
      ]),
    ).toBe('done');
  });

  it('does not report done when one item is still replied', () => {
    expect(
      deriveThreadStatusFromItems([
        { status: 'done', fromMe: false },
        { status: 'replied', fromMe: true },
      ]),
    ).toBe('replied');
  });

  it('falls back to replied for a fully answered thread', () => {
    expect(
      deriveThreadStatusFromItems([{ status: 'replied', fromMe: true }]),
    ).toBe('replied');
  });

  // An empty thread must not satisfy `every(...)` vacuously and report done.
  it('does not report done for an empty item list', () => {
    expect(deriveThreadStatusFromItems([])).toBe('replied');
  });
});

describe('thread cursor codec', () => {
  it('round-trips a timestamp and key', () => {
    const at = new Date('2026-09-16T10:30:00.000Z');
    const decoded = decodeThreadCursor(
      encodeThreadCursor({ at, key: '7:abc' }),
    );
    expect(decoded?.at.toISOString()).toBe(at.toISOString());
    expect(decoded?.key).toBe('7:abc');
  });

  it('round-trips a key containing colons', () => {
    const at = new Date('2026-09-16T10:30:00.000Z');
    const decoded = decodeThreadCursor(
      encodeThreadCursor({ at, key: '7:page_123:psid_456' }),
    );
    expect(decoded?.key).toBe('7:page_123:psid_456');
  });

  // Cursors issued before this change were bare ISO timestamps. A user
  // mid-scroll across the deploy should get one redundant refetch, not an error.
  it('accepts a legacy bare ISO timestamp cursor', () => {
    const decoded = decodeThreadCursor('2026-09-16T10:30:00.000Z');
    expect(decoded?.at.toISOString()).toBe('2026-09-16T10:30:00.000Z');
    // Sorts after every real key, reproducing the old timestamp-only behaviour.
    expect(decoded?.key).toBe('￿');
  });

  it('returns null for an absent cursor', () => {
    expect(decodeThreadCursor(undefined)).toBeNull();
  });

  // Must degrade to page one rather than 500 on a cursor from an older format
  // or a hand-edited URL.
  it('returns null for unparseable input instead of throwing', () => {
    expect(decodeThreadCursor('not-a-cursor')).toBeNull();
    expect(decodeThreadCursor('!!!')).toBeNull();
  });

  it('returns null for base64 JSON whose timestamp is invalid', () => {
    const bad = Buffer.from(
      JSON.stringify({ at: 'never', key: '1:x' }),
    ).toString('base64url');
    expect(decodeThreadCursor(bad)).toBeNull();
  });
});

describe('decodeThreadKey', () => {
  it('splits a comment key into channel id and platform post id', () => {
    expect(decodeThreadKey('7:post_abc')).toEqual({
      channelId: 7,
      remainder: 'post_abc',
    });
  });

  // The discriminating case: Facebook DM conversation ids are themselves
  // `pageId:senderPsid`, so splitting on every colon corrupts the key.
  it('keeps colons in the remainder for a Facebook DM key', () => {
    expect(decodeThreadKey('7:page_123:psid_456')).toEqual({
      channelId: 7,
      remainder: 'page_123:psid_456',
    });
  });

  it('returns null when the channel id is not a number', () => {
    expect(decodeThreadKey('abc:post_1')).toBeNull();
  });

  it('returns null when there is no remainder', () => {
    expect(decodeThreadKey('7:')).toBeNull();
  });

  it('returns null when there is no colon at all', () => {
    expect(decodeThreadKey('7')).toBeNull();
  });

  it('returns null for a leading colon', () => {
    expect(decodeThreadKey(':post_1')).toBeNull();
  });
});
