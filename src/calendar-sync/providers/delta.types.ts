// =============================================================================
// Calendar delta — shared provider-agnostic types
// -----------------------------------------------------------------------------
// Both `google-delta.util.ts` and `outlook-delta.util.ts` normalize their raw
// provider payloads into these shapes so `CalendarPullSyncService` stays
// provider-agnostic.
// =============================================================================

/**
 * A single external calendar event, normalized across Google Calendar v3 and
 * Microsoft Graph.
 */
export interface NormalizedExternalEvent {
  /** Provider event id (Google `id`, Graph `id`). */
  externalEventId: string;
  /** Id of the calendar the event was read from (the connection's PRIMARY). */
  calendarId: string;
  /** Event title (Google `summary`, Graph `subject`). Empty string when absent. */
  title: string;
  /** Event start. Null when the provider returned an unparseable/absent start. */
  startsAt: Date | null;
  /** Event end. Null when the provider returned an unparseable/absent end. */
  endsAt: Date | null;
  /** All-day event (Google `start.date`, Graph `isAllDay`). */
  isAllDay: boolean;
  /** Deep link back to the event in the provider UI (Google `htmlLink`, Graph `webLink`). */
  htmlLink?: string;
  /** Provider's last-modified timestamp (Google `updated`, Graph `lastModifiedDateTime`). */
  externalUpdatedAt: Date | null;
  /**
   * True when the event carries OUR ownership tag (i.e. Schedura wrote it for a
   * scheduled post). Such events are NOT imported as external events — they are
   * the two-way write-back surface (Task D).
   */
  isOurs: boolean;
  /** The tagged post id, when `isOurs`. */
  postId?: string;
  /** Provider concurrency token (Google `etag`, Graph `@odata.etag`). */
  etag?: string;
  /** Raw provider payload (persisted to `external_calendar_events.raw`). */
  raw: unknown;
}

/**
 * Result of one incremental (or bounded-full) pull of a provider's PRIMARY
 * calendar.
 */
export interface CalendarDeltaResult {
  /** Created/updated events in this delta window. */
  changed: NormalizedExternalEvent[];
  /** Provider event ids that were cancelled/removed. */
  deleted: string[];
  /**
   * Cursor to persist for the next incremental run (Google `nextSyncToken` →
   * `calendar_sync_state.sync_token`; Graph `@odata.deltaLink` →
   * `calendar_sync_state.delta_link`). Undefined when the provider did not hand
   * one back (e.g. the run aborted on a page cap).
   */
  nextCursor?: string;
  /**
   * The stored cursor was rejected (Google 410 GONE / Graph
   * `syncStateNotFound` | `resyncRequired`). The caller must clear the cursor
   * and re-run as a bounded FULL list.
   */
  needsFullResync: boolean;
  /**
   * The run stopped early on the page cap, so `changed`/`deleted` are only a
   * PREFIX of what the provider had. Distinguishes "we truncated" from "the
   * provider legitimately handed back no cursor".
   *
   * The caller MUST NOT prune (an event missing from a truncated page set was
   * merely not fetched, not deleted) and MUST NOT advance the cursor.
   */
  truncated: boolean;
}

/** Options accepted by both provider delta utils. */
export interface CalendarDeltaOptions {
  accessToken: string;
  /** PRIMARY calendar id for this connection. Defaults to `'primary'`. */
  calendarId?: string;
  /**
   * Stored cursor from `calendar_sync_state` (Google syncToken / Graph
   * deltaLink). Absent/null → bounded full list.
   */
  cursor?: string | null;
  /** Injectable clock for the bounded window (tests). Defaults to `new Date()`. */
  now?: Date;
  /** Safety cap on pagination pages. */
  maxPages?: number;
}

// -----------------------------------------------------------------------------
// Bounded full-sync window. A full (re)sync never lists the user's entire
// calendar history — only a window around "now", which is all the calendar UI
// ever renders.
// -----------------------------------------------------------------------------
export const FULL_SYNC_PAST_DAYS = 30;
export const FULL_SYNC_FUTURE_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `[now-30d, now+90d]` — the bounded window used by every full list. */
export function fullSyncWindow(now: Date = new Date()): {
  timeMin: Date;
  timeMax: Date;
} {
  return {
    timeMin: new Date(now.getTime() - FULL_SYNC_PAST_DAYS * MS_PER_DAY),
    timeMax: new Date(now.getTime() + FULL_SYNC_FUTURE_DAYS * MS_PER_DAY),
  };
}

/** Default pagination cap (pages, not events) for one delta run. */
export const DEFAULT_MAX_PAGES = 20;
