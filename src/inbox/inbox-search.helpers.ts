import { sql, SQL } from 'drizzle-orm';
import { inboxItems } from '../drizzle/schema/inbox.schema';
import type { InboxItemStatus } from '../drizzle/schema/inbox.schema';
import { DEFAULT_INBOX_SORT, INBOX_SORTS } from './inbox-sort.constants';
import type { InboxSort } from './inbox-sort.constants';
import type { InboxFolder } from './dto/list-comments.dto';

/**
 * Pure helpers for inbox listing: search predicates, folder mapping, thread
 * status derivation and cursor codec.
 *
 * These live outside `InboxService` on purpose. `db` is a module-level
 * singleton (`src/drizzle/db.ts`), so anything reaching for it can only be
 * tested behind a hand-built query-builder mock. Everything here is a pure
 * function of its arguments and is unit-tested directly — see
 * `inbox-search.spec.ts`.
 */

/** Minimum query length we will run. Below this the trigram index cannot help
 *  and the substring matches most rows anyway, so we treat it as "no search". */
export const MIN_SEARCH_LENGTH = 2;

/**
 * Escape the characters that are wildcards inside a SQL `LIKE` pattern.
 *
 * Without this, searching for `50%` matches every row, and a lone `_` matches
 * any single character. Backslash is escaped first because it is the escape
 * character itself.
 */
export function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * The searchable haystack expression, as SQL.
 *
 * MUST STAY BYTE-IDENTICAL to the expression indexed by
 * `inbox_search_trgm_idx` in migration 0036. Postgres matches expression
 * indexes structurally: reorder the coalesces or change the separator and the
 * planner quietly stops using the index, turning search into a sequential scan
 * of the whole table. `inbox-search.spec.ts` asserts the two stay in step.
 */
export function searchHaystackSql(): SQL {
  return sql`(lower(coalesce(${inboxItems.text}, '')) || ' ' || lower(coalesce(${inboxItems.authorHandle}, '')) || ' ' || lower(coalesce(${inboxItems.authorDisplayName}, '')))`;
}

/** The caption expression, matching `inbox_caption_trgm_idx` in 0036. */
export function searchCaptionSql(): SQL {
  return sql`lower(coalesce(${inboxItems.metadata}->'post'->>'caption', ''))`;
}

/**
 * Row-level search predicate: does THIS row match the query?
 *
 * Callers wrap it in `bool_or(...)` when aggregating a thread, which is what
 * makes a hit on any one comment surface the entire post thread rather than a
 * bare comment row.
 *
 * `lower(...) LIKE lower-pattern` rather than `ILIKE` so the expression matches
 * the index definition exactly. A leading `%` is what `gin_trgm_ops`
 * accelerates, so the unanchored pattern is intentional.
 *
 * Use this in Drizzle query-builder `where(...)` clauses, where the table is
 * referenced by its real name. Inside the hand-written aggregate CTEs the table
 * carries an alias, and a fully-qualified `inbox_items.text` there is an
 * "invalid reference to FROM-clause entry" — those callers want
 * `buildAliasedSearchCondition` instead.
 */
export function buildSearchCondition(query: string): SQL {
  const needle = `%${escapeLikePattern(query.toLowerCase())}%`;
  return sql`(${searchHaystackSql()} LIKE ${needle} ESCAPE '\\' OR ${searchCaptionSql()} LIKE ${needle} ESCAPE '\\')`;
}

/**
 * The same predicate, written against a table ALIAS rather than the table name.
 *
 * The aggregate listings are raw SQL over `FROM inbox_items i`, so every column
 * has to be reached as `i.<column>`. Drizzle's column references always render
 * as `"inbox_items"."<column>"`, which Postgres rejects once the table has been
 * aliased — the alias shadows the name.
 *
 * The expression text is otherwise identical to `searchHaystackSql()` and to
 * `inbox_search_trgm_idx` in migration 0036, which is what keeps the trigram
 * index usable; `inbox-search.spec.ts` pins all three together.
 */
export function buildAliasedSearchCondition(query: string, alias: string): SQL {
  const needle = `%${escapeLikePattern(query.toLowerCase())}%`;
  const a = sql.raw(alias);
  return sql`((lower(coalesce(${a}.text, '')) || ' ' || lower(coalesce(${a}.author_handle, '')) || ' ' || lower(coalesce(${a}.author_display_name, ''))) LIKE ${needle} ESCAPE '\\' OR lower(coalesce(${a}.metadata->'post'->>'caption', '')) LIKE ${needle} ESCAPE '\\')`;
}

/**
 * "This row has one of these statuses", written against a table alias.
 *
 * Deliberately an `IN (...)` list rather than `= ANY(${statuses})`. Drizzle
 * unwraps a single-element array into a scalar parameter, so `ANY()` receives
 * `'unread'` instead of `{unread}` and Postgres fails with
 * "malformed array literal" — which made every folder filter a 500. Joining the
 * values binds each one separately and cannot degrade that way.
 */
export function buildAliasedStatusCondition(
  statuses: InboxItemStatus[],
  alias: string,
): SQL {
  const a = sql.raw(alias);
  const values = sql.join(
    statuses.map((s) => sql`${s}`),
    sql`, `,
  );
  return sql`${a}.status IN (${values})`;
}

/** Normalise a raw `q` param: trimmed, or undefined when too short to run. */
export function normalizeSearchQuery(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed.length < MIN_SEARCH_LENGTH) return undefined;
  return trimmed;
}

/**
 * Folder → the statuses a thread must contain at least one of.
 *
 * An explicit `status` param still wins over the folder. `all` (and an absent
 * folder) means no status filter at all.
 *
 * Unlike the old `folderToStatus`, `replied` is a real folder here. It used to
 * map to nothing, so replying to a conversation made it disappear from every
 * folder except `all`.
 */
export function folderToStatuses(
  folder?: InboxFolder,
  status?: InboxItemStatus,
): InboxItemStatus[] | undefined {
  if (status) return [status];
  if (!folder || folder === 'all') return undefined;
  return [folder];
}

/** The four status flags an aggregate query reports for a thread. */
export interface ThreadStatusFlags {
  hasUnread: boolean;
  hasNeedsReply: boolean;
  allDone: boolean;
}

/**
 * Thread-level status — one colour for the list row.
 *
 * Priority: any incoming unread → 'unread'; else any needs_reply →
 * 'needs_reply'; else every item done → 'done'; else 'replied'.
 *
 * Note `hasUnread` must already exclude our own rows (`from_me`): an unread
 * flag on a message we sent is not something the user has to read.
 *
 * Shared by the aggregate list path (which computes the flags in SQL) and
 * thread detail (which has the rows in hand) so the two cannot drift.
 */
export function deriveThreadStatusFromFlags(
  flags: ThreadStatusFlags,
): InboxItemStatus {
  if (flags.hasUnread) return 'unread';
  if (flags.hasNeedsReply) return 'needs_reply';
  if (flags.allDone) return 'done';
  return 'replied';
}

/** Same decision, from rows rather than flags. */
export function deriveThreadStatusFromItems(
  items: { status: InboxItemStatus; fromMe: boolean }[],
): InboxItemStatus {
  return deriveThreadStatusFromFlags({
    hasUnread: items.some((i) => i.status === 'unread' && !i.fromMe),
    hasNeedsReply: items.some((i) => i.status === 'needs_reply'),
    allDone: items.length > 0 && items.every((i) => i.status === 'done'),
  });
}

// ===========================================================================
// Sorting
// ===========================================================================

/**
 * How each sort orders the aggregate, as a keyset the cursor can walk.
 *
 * `unanswered` is a two-level sort: threads still awaiting a reply first, then
 * newest within each group. That makes the keyset three columns wide, so the
 * cursor carries the group flag as well as the timestamp — comparing only the
 * timestamp would jump the boundary between the two groups and drop whatever
 * sits on the far side of it.
 */
export interface SortSpec {
  /** Direction of the timestamp leg. */
  direction: 'asc' | 'desc';
  /** True when the sort groups unanswered threads ahead of the rest. */
  groupsByUnanswered: boolean;
}

export const SORT_SPECS: Record<InboxSort, SortSpec> = {
  newest: { direction: 'desc', groupsByUnanswered: false },
  oldest: { direction: 'asc', groupsByUnanswered: false },
  unanswered: { direction: 'desc', groupsByUnanswered: true },
};

export function normalizeSort(raw?: string): InboxSort {
  return INBOX_SORTS.includes(raw as InboxSort)
    ? (raw as InboxSort)
    : DEFAULT_INBOX_SORT;
}

/**
 * "This thread is still waiting on us" — the grouping column of the
 * `unanswered` sort, and a selected column so the cursor can carry it.
 *
 * Unread or needs_reply both mean nobody has answered yet; replied and done do
 * not. Computed from the same aggregate flags the row already reports.
 */
export function awaitingReplySql(): SQL {
  return sql`(bool_or(i.status = 'unread' AND i.from_me = false) OR bool_or(i.status = 'needs_reply'))`;
}

/** The ORDER BY for a sort, applied to an aliased `thread_agg` row. */
export function buildSortOrder(sort: InboxSort, alias: string): SQL {
  const a = sql.raw(alias);
  const spec = SORT_SPECS[sort];
  const time = spec.direction === 'asc' ? sql`ASC` : sql`DESC`;
  // The key tiebreak follows the timestamp direction, so the composite
  // comparison in the cursor filter stays a simple row-value inequality.
  const tie = spec.direction === 'asc' ? sql`ASC` : sql`DESC`;

  if (spec.groupsByUnanswered) {
    // DESC puts true (awaiting) first.
    return sql`${a}.awaiting_reply DESC, ${a}.last_activity_at ${time}, ${a}.thread_key ${tie}`;
  }
  return sql`${a}.last_activity_at ${time}, ${a}.thread_key ${tie}`;
}

/**
 * The keyset predicate that continues a page under a given sort.
 *
 * Row-value comparison rather than an unrolled OR chain: `(a, b) < (x, y)` is
 * exactly the "everything after this row in this ordering" the sort defines,
 * and Postgres can use an index for it.
 */
export function buildCursorFilter(
  cursor: ThreadCursor,
  sort: InboxSort,
  alias: string,
): SQL {
  const a = sql.raw(alias);
  const spec = SORT_SPECS[sort];
  const op = sql.raw(spec.direction === 'asc' ? '>' : '<');

  if (spec.groupsByUnanswered) {
    // Every leg of this sort descends — `awaiting_reply DESC` puts true first,
    // and `false < true` makes that the same direction as the timestamp — so
    // the keyset is one plain row-value comparison with no negation anywhere.
    // Verified against a fixture: paging a mixed list this way reproduces the
    // full ordering exactly, with no repeated or skipped row at the boundary.
    const awaiting = cursor.awaiting ?? true;
    return sql`WHERE (${a}.awaiting_reply, ${a}.last_activity_at, ${a}.thread_key) ${op} (${awaiting}, ${cursor.at}, ${cursor.key})`;
  }

  return sql`WHERE (${a}.last_activity_at, ${a}.thread_key) ${op} (${cursor.at}, ${cursor.key})`;
}

// ===========================================================================
// Keyset cursor
// ===========================================================================

export interface ThreadCursor {
  /** `last_activity_at` of the last thread on the previous page. */
  at: Date;
  /** That thread's key — the tiebreak. */
  key: string;
  /**
   * Whether that thread was in the "awaiting reply" group. Only meaningful for
   * the `unanswered` sort, whose first ordering column this is.
   */
  awaiting?: boolean;
  /**
   * The sort the cursor was issued under. A cursor from one ordering is
   * meaningless in another — it would skip or repeat whole runs — so changing
   * the sort discards it and starts again at page one.
   */
  sort?: InboxSort;
}

/**
 * Sorts after every real thread key, so a legacy timestamp-only cursor
 * behaves exactly like the old `platform_created_at < cursor` did.
 */
const MAX_KEY_SENTINEL = '￿';

export function encodeThreadCursor(cursor: ThreadCursor): string {
  return Buffer.from(
    JSON.stringify({
      at: cursor.at.toISOString(),
      key: cursor.key,
      ...(cursor.awaiting === undefined ? {} : { awaiting: cursor.awaiting }),
      ...(cursor.sort === undefined ? {} : { sort: cursor.sort }),
    }),
  ).toString('base64url');
}

/**
 * A cursor is only valid within the ordering that issued it.
 *
 * Paging with a cursor from a different sort walks the wrong keyset and
 * silently skips or repeats whole runs of threads, so a sort change starts
 * again from page one rather than continuing from a meaningless position.
 */
export function isCursorValidForSort(
  cursor: ThreadCursor | null,
  sort: InboxSort,
): cursor is ThreadCursor {
  if (!cursor) return false;
  // A legacy cursor carries no sort; it predates sorting, so it belongs to the
  // default ordering.
  return (cursor.sort ?? DEFAULT_INBOX_SORT) === sort;
}

/**
 * Decode a cursor, tolerating both formats and never throwing.
 *
 * Threads are ordered by `(last_activity_at DESC, key DESC)` because the
 * timestamp alone is not unique — two threads can share a `max()` to the
 * microsecond after a bulk import, and a cursor that cannot break that tie
 * silently skips or repeats a row at the page boundary.
 *
 * A bare ISO string is accepted as the pre-0036 cursor format, so a user
 * mid-scroll across a deploy gets one redundant refetch instead of an error.
 * Anything unparseable returns null, which the caller treats as page one.
 */
export function decodeThreadCursor(raw?: string): ThreadCursor | null {
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    );
    if (parsed && typeof parsed === 'object') {
      const { at, key, awaiting, sort } = parsed as {
        at?: unknown;
        key?: unknown;
        awaiting?: unknown;
        sort?: unknown;
      };
      if (typeof at === 'string' && typeof key === 'string') {
        const date = new Date(at);
        if (!Number.isNaN(date.getTime())) {
          return {
            at: date,
            key,
            ...(typeof awaiting === 'boolean' ? { awaiting } : {}),
            ...(INBOX_SORTS.includes(sort as InboxSort)
              ? { sort: sort as InboxSort }
              : {}),
          };
        }
      }
    }
  } catch {
    // Not a base64 JSON cursor — fall through to the legacy format.
  }

  const legacy = new Date(raw);
  if (!Number.isNaN(legacy.getTime())) {
    return { at: legacy, key: MAX_KEY_SENTINEL };
  }

  return null;
}

// ===========================================================================
// Thread keys
// ===========================================================================

export interface DecodedThreadKey {
  channelId: number;
  /** Platform post id (comments) or conversation id (DMs). */
  remainder: string;
}

/**
 * Split `channelId:<rest>` on the FIRST colon only.
 *
 * The remainder legitimately contains colons — Facebook DM conversation ids
 * are `pageId:senderPsid` — so splitting on every colon corrupts the key.
 * Returns null rather than throwing: a bulk action given one stale key among
 * two hundred should report that key as failed, not reject the whole request.
 */
export function decodeThreadKey(threadKey: string): DecodedThreadKey | null {
  const separatorIndex = threadKey.indexOf(':');
  if (separatorIndex <= 0) return null;

  const channelId = Number(threadKey.slice(0, separatorIndex));
  const remainder = threadKey.slice(separatorIndex + 1);

  if (!Number.isInteger(channelId) || channelId <= 0) return null;
  if (!remainder) return null;

  return { channelId, remainder };
}
