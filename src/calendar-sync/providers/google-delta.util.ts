import { Logger } from '@nestjs/common';
import {
  SCHEDURA_MESSAGE_ID_PROP,
  SCHEDURA_POST_ID_PROP,
} from '../calendar-sync.constants';
import {
  CalendarDeltaOptions,
  CalendarDeltaResult,
  DEFAULT_MAX_PAGES,
  NormalizedExternalEvent,
  fullSyncWindow,
} from './delta.types';

const logger = new Logger('GoogleCalendarDelta');

const API_BASE_URL = 'https://www.googleapis.com/calendar/v3';

// Google caps `maxResults` at 2500; 250/page keeps payloads small.
const PAGE_SIZE = 250;

/**
 * Google Calendar v3 event (subset we consume).
 */
interface GoogleEvent {
  id: string;
  status?: string; // 'confirmed' | 'tentative' | 'cancelled'
  etag?: string;
  summary?: string;
  htmlLink?: string;
  updated?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  extendedProperties?: {
    private?: Record<string, string>;
    shared?: Record<string, string>;
  };
}

interface GoogleEventsListResponse {
  items?: GoogleEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

/**
 * Incrementally list a Google Calendar's events.
 *
 * - With a stored `cursor` (Google `nextSyncToken`) → an INCREMENTAL list: only
 *   the events that changed since the token was issued, including cancellations.
 * - Without a cursor → a bounded FULL list (`now-30d` … `now+90d`,
 *   `singleEvents=true`), which is what we fall back to after a 410. This is the
 *   ONLY request that can mint a `nextSyncToken`, so it must never send
 *   `orderBy` (see `buildUrl`).
 *
 * A **410 GONE** means the sync token expired/was invalidated → the result is
 * `{ needsFullResync: true }` and the caller must clear the cursor and re-run
 * without one.
 *
 * Ownership detection: an event is OURS when it carries
 * `extendedProperties.private[schedura_post_id]` (written by the push service).
 * Those events are never imported as external events.
 */
export async function fetchGoogleCalendarDelta(
  options: CalendarDeltaOptions,
): Promise<CalendarDeltaResult> {
  const {
    accessToken,
    calendarId = 'primary',
    cursor,
    now = new Date(),
    maxPages = DEFAULT_MAX_PAGES,
  } = options;

  const changed: NormalizedExternalEvent[] = [];
  const deleted: string[] = [];

  let pageToken: string | undefined;
  let nextCursor: string | undefined;
  let pages = 0;

  do {
    const url = buildUrl({ calendarId, cursor, pageToken, now });

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    // Expired/invalidated sync token → the caller must do a bounded full resync.
    if (response.status === 410) {
      logger.warn(
        `Google sync token for calendar ${calendarId} is GONE (410) — full resync required`,
      );
      return {
        changed: [],
        deleted: [],
        needsFullResync: true,
        truncated: false,
      };
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Google Calendar delta failed (${response.status}): ${body.slice(0, 500)}`,
      );
    }

    const data = (await response.json()) as GoogleEventsListResponse;

    for (const item of data.items ?? []) {
      if (!item?.id) continue;
      // Incremental lists surface deletions as `status: 'cancelled'` tombstones.
      if (item.status === 'cancelled') {
        deleted.push(item.id);
        continue;
      }
      changed.push(normalizeGoogleEvent(item, calendarId));
    }

    pageToken = data.nextPageToken;
    nextCursor = data.nextSyncToken ?? nextCursor;
    pages += 1;

    if (pageToken && pages >= maxPages) {
      // Page cap hit: the result is only a PREFIX of the provider's stream.
      // Return no cursor AND flag `truncated` so the caller keeps its previous
      // cursor and skips the prune (a missing event here was merely not
      // fetched — it was not deleted).
      logger.warn(
        `Google Calendar delta hit the ${maxPages}-page cap for calendar ${calendarId}; truncating this run`,
      );
      return {
        changed,
        deleted,
        nextCursor: undefined,
        needsFullResync: false,
        truncated: true,
      };
    }
  } while (pageToken);

  return {
    changed,
    deleted,
    nextCursor,
    needsFullResync: false,
    truncated: false,
  };
}

/**
 * Build the `events.list` URL.
 *
 * Two hard Google constraints shape this:
 *  1. **Never send `orderBy` on the full list.** Google OMITS `nextSyncToken`
 *     from any response whose request carried `orderBy` — the cursor would
 *     never be minted, every run would re-do a full list, and (because a full
 *     list carries no tombstones) external deletes would never reach us.
 *  2. **Keep the parameter set stable.** Google invalidates a syncToken whose
 *     follow-up request changes the filters, so `showDeleted` is sent on BOTH
 *     the initial full list and the incremental one.
 *
 * With a sync token we must NOT re-send the window filters (Google rejects a
 * syncToken combined with timeMin/timeMax); without one we send the bounded
 * full-sync window.
 */
function buildUrl(args: {
  calendarId: string;
  cursor?: string | null;
  pageToken?: string;
  now: Date;
}): string {
  const { calendarId, cursor, pageToken, now } = args;

  const params = new URLSearchParams({
    maxResults: String(PAGE_SIZE),
    singleEvents: 'true',
    // Stable across BOTH branches (see #2 above). On the incremental list this
    // is what surfaces deletions as `status: 'cancelled'` tombstones.
    showDeleted: 'true',
  });

  if (cursor) {
    // Incremental: token-only request.
    params.set('syncToken', cursor);
  } else {
    // Bounded full list — the ONLY request that mints a nextSyncToken, hence no
    // `orderBy` (see #1 above). Ordering is irrelevant: we upsert by event id.
    const { timeMin, timeMax } = fullSyncWindow(now);
    params.set('timeMin', timeMin.toISOString());
    params.set('timeMax', timeMax.toISOString());
  }

  if (pageToken) {
    params.set('pageToken', pageToken);
  }

  return `${API_BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
}

/**
 * Google event → NormalizedExternalEvent.
 */
function normalizeGoogleEvent(
  item: GoogleEvent,
  calendarId: string,
): NormalizedExternalEvent {
  const postId = item.extendedProperties?.private?.[SCHEDURA_POST_ID_PROP];
  const messageId =
    item.extendedProperties?.private?.[SCHEDURA_MESSAGE_ID_PROP];
  const isAllDay = Boolean(item.start?.date);

  return {
    externalEventId: item.id,
    calendarId,
    title: item.summary ?? '',
    startsAt: parseGoogleDate(item.start),
    endsAt: parseGoogleDate(item.end),
    isAllDay,
    htmlLink: item.htmlLink,
    externalUpdatedAt: item.updated ? toDateOrNull(item.updated) : null,
    isOurs: Boolean(postId || messageId),
    postId: postId || undefined,
    messageId: messageId || undefined,
    etag: item.etag,
    raw: item,
  };
}

/**
 * Google returns either `dateTime` (timed events, RFC3339 with offset) or
 * `date` (all-day, `YYYY-MM-DD` → treated as UTC midnight).
 */
function parseGoogleDate(
  slot?: { dateTime?: string; date?: string } | null,
): Date | null {
  if (!slot) return null;
  if (slot.dateTime) return toDateOrNull(slot.dateTime);
  if (slot.date) return toDateOrNull(`${slot.date}T00:00:00.000Z`);
  return null;
}

function toDateOrNull(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
