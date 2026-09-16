import { sql, SQL } from 'drizzle-orm';
import { inboxItems } from '../drizzle/schema/inbox.schema';
import type { InboxItemStatus } from '../drizzle/schema/inbox.schema';
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
 */
export function buildSearchCondition(query: string): SQL {
  const needle = `%${escapeLikePattern(query.toLowerCase())}%`;
  return sql`(${searchHaystackSql()} LIKE ${needle} ESCAPE '\\' OR ${searchCaptionSql()} LIKE ${needle} ESCAPE '\\')`;
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
// Keyset cursor
// ===========================================================================

export interface ThreadCursor {
  /** `last_activity_at` of the last thread on the previous page. */
  at: Date;
  /** That thread's key — the tiebreak. */
  key: string;
}

/**
 * Sorts after every real thread key, so a legacy timestamp-only cursor
 * behaves exactly like the old `platform_created_at < cursor` did.
 */
const MAX_KEY_SENTINEL = '￿';

export function encodeThreadCursor(cursor: ThreadCursor): string {
  return Buffer.from(
    JSON.stringify({ at: cursor.at.toISOString(), key: cursor.key }),
  ).toString('base64url');
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
      const { at, key } = parsed as { at?: unknown; key?: unknown };
      if (typeof at === 'string' && typeof key === 'string') {
        const date = new Date(at);
        if (!Number.isNaN(date.getTime())) return { at: date, key };
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
