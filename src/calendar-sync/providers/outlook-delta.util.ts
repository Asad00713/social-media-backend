import { Logger } from '@nestjs/common';
import {
  GRAPH_MESSAGE_ID_PROP_ID,
  GRAPH_POST_ID_PROP_ID,
} from '../calendar-sync.constants';
import {
  CalendarDeltaOptions,
  CalendarDeltaResult,
  DEFAULT_MAX_PAGES,
  NormalizedExternalEvent,
  fullSyncWindow,
} from './delta.types';

const logger = new Logger('OutlookCalendarDelta');

const API_BASE_URL = 'https://graph.microsoft.com/v1.0';

// Graph page size for the delta stream (via the `Prefer: odata.maxpagesize` header).
const PAGE_SIZE = 200;

/**
 * Microsoft Graph event (subset we consume) as returned by the delta stream.
 */
interface GraphDeltaEvent {
  id: string;
  '@odata.etag'?: string;
  '@removed'?: { reason?: string };
  subject?: string;
  isAllDay?: boolean;
  webLink?: string;
  lastModifiedDateTime?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  singleValueExtendedProperties?: Array<{ id: string; value?: string }>;
}

interface GraphDeltaResponse {
  value?: GraphDeltaEvent[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

/**
 * Incrementally list the user's PRIMARY Outlook calendar via Microsoft Graph's
 * `calendarView` delta stream.
 *
 * - With a stored `cursor` (a full `@odata.deltaLink` URL) → an INCREMENTAL
 *   pull: only what changed since that link was issued, including `@removed`
 *   tombstones.
 * - Without a cursor → a bounded FULL pull (`now-30d` … `now+90d`), which is
 *   also the fallback after an invalid/expired deltaLink.
 *
 * An expired/invalid deltaLink surfaces as **410 GONE** (or a
 * `syncStateNotFound` / `resyncRequired` error code) → the result is
 * `{ needsFullResync: true }`.
 *
 * Ownership detection: Graph does **not** support `$expand` on the delta
 * endpoints (a `$expand=singleValueExtendedProperties(...)` makes the request
 * 400), so the delta payload never carries our named MAPI tag and `isOurs` is
 * effectively always false here. Ownership for Outlook is therefore decided by
 * the AUTHORITATIVE `calendar_item_links` lookup in `CalendarPullSyncService`
 * (`loadLinkedEventIds` / `loadLink`), which treats any event with a link row as
 * ours. `readTag()` below is kept as a belt-and-braces reader for the rare
 * payloads (non-delta refetches) that do carry the properties.
 */
export async function fetchOutlookCalendarDelta(
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

  // A stored deltaLink is a complete URL (it already carries the window + the
  // delta token), so it is used verbatim.
  let url: string | undefined = cursor || buildInitialUrl(now);
  let nextCursor: string | undefined;
  let pages = 0;

  while (url) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        // Graph carries the zone separately; force UTC so `start.dateTime`
        // is always UTC wall-clock and parses deterministically.
        Prefer: `odata.maxpagesize=${PAGE_SIZE}, outlook.timezone="UTC"`,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      if (isResyncRequired(response.status, body)) {
        logger.warn(
          `Outlook deltaLink for calendar ${calendarId} is invalid/expired (${response.status}) — full resync required`,
        );
        return {
          changed: [],
          deleted: [],
          needsFullResync: true,
          truncated: false,
        };
      }
      throw new Error(
        `Outlook Calendar delta failed (${response.status}): ${body.slice(0, 500)}`,
      );
    }

    const data = (await response.json()) as GraphDeltaResponse;

    for (const item of data.value ?? []) {
      if (!item?.id) continue;
      // Graph surfaces deletions as `@removed` tombstones.
      if (item['@removed']) {
        deleted.push(item.id);
        continue;
      }
      changed.push(normalizeGraphEvent(item, calendarId));
    }

    if (data['@odata.deltaLink']) {
      nextCursor = data['@odata.deltaLink'];
      break;
    }

    url = data['@odata.nextLink'];
    pages += 1;

    if (url && pages >= maxPages) {
      // Page cap hit: the result is only a PREFIX of the delta stream. Return no
      // cursor AND flag `truncated` so the caller keeps its previous cursor and
      // skips the prune (a missing event here was merely not fetched).
      logger.warn(
        `Outlook Calendar delta hit the ${maxPages}-page cap for calendar ${calendarId}; truncating this run`,
      );
      return {
        changed,
        deleted,
        nextCursor: undefined,
        needsFullResync: false,
        truncated: true,
      };
    }
  }

  return {
    changed,
    deleted,
    nextCursor,
    needsFullResync: false,
    truncated: false,
  };
}

/**
 * Initial (no-cursor) bounded delta request against the PRIMARY calendar.
 *
 * NO `$expand`: Microsoft Graph does not support `$expand` on the delta
 * endpoints — `/me/calendarView/delta?$expand=singleValueExtendedProperties(...)`
 * is rejected with a 400, which killed the entire Outlook pull. Ownership is
 * resolved from `calendar_item_links` in the pull service instead (see the
 * module doc above).
 */
function buildInitialUrl(now: Date): string {
  const { timeMin, timeMax } = fullSyncWindow(now);

  const query = [
    `startDateTime=${encodeURIComponent(timeMin.toISOString())}`,
    `endDateTime=${encodeURIComponent(timeMax.toISOString())}`,
  ].join('&');

  return `${API_BASE_URL}/me/calendarView/delta?${query}`;
}

/**
 * Graph signals "your delta token is no longer usable, start over" as a 410
 * GONE, and (depending on the endpoint) as a 400/404 carrying the
 * `syncStateNotFound` / `resyncRequired` error code.
 */
function isResyncRequired(status: number, body: string): boolean {
  if (status === 410) return true;
  const lowered = body.toLowerCase();
  return (
    lowered.includes('syncstatenotfound') || lowered.includes('resyncrequired')
  );
}

/**
 * Graph event → NormalizedExternalEvent.
 */
function normalizeGraphEvent(
  item: GraphDeltaEvent,
  calendarId: string,
): NormalizedExternalEvent {
  const postId = readTag(item, GRAPH_POST_ID_PROP_ID);
  const messageId = readTag(item, GRAPH_MESSAGE_ID_PROP_ID);

  return {
    externalEventId: item.id,
    calendarId,
    title: item.subject ?? '',
    startsAt: parseGraphDate(item.start),
    endsAt: parseGraphDate(item.end),
    isAllDay: Boolean(item.isAllDay),
    htmlLink: item.webLink,
    externalUpdatedAt: item.lastModifiedDateTime
      ? toDateOrNull(item.lastModifiedDateTime)
      : null,
    isOurs: Boolean(postId || messageId),
    postId: postId || undefined,
    messageId: messageId || undefined,
    etag: item['@odata.etag'],
    raw: item,
  };
}

/**
 * Read one of our ownership tags out of the extended properties WHEN Graph
 * happens to include them. The delta stream never does (no `$expand` support),
 * so this returns undefined there and `calendar_item_links` decides ownership —
 * but a non-delta payload can carry them, and reading it is free. Graph can echo
 * the property id with different casing/whitespace than we sent, so the match is
 * case-insensitive on the `Name <prop>` suffix as well as exact.
 */
function readTag(item: GraphDeltaEvent, propId: string): string | undefined {
  const props = item.singleValueExtendedProperties;
  if (!props?.length) return undefined;

  const wantedSuffix = propId
    .slice(propId.toLowerCase().indexOf('name '))
    .toLowerCase();

  const hit = props.find((prop) => {
    if (!prop?.id) return false;
    const id = prop.id.toLowerCase();
    return (
      prop.id === propId ||
      (wantedSuffix.length > 0 && id.endsWith(wantedSuffix))
    );
  });

  return hit?.value ? hit.value : undefined;
}

/**
 * Graph returns `dateTime` WITHOUT a trailing `Z` plus a separate `timeZone`.
 * We request `outlook.timezone="UTC"`, so an offset-less value is UTC.
 */
function parseGraphDate(
  slot?: { dateTime?: string; timeZone?: string } | null,
): Date | null {
  if (!slot?.dateTime) return null;
  const value = slot.dateTime;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  return toDateOrNull(hasZone ? value : `${value}Z`);
}

function toDateOrNull(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
