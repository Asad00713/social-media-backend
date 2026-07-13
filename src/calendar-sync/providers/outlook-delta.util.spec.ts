import { fetchOutlookCalendarDelta } from './outlook-delta.util';
import { GRAPH_POST_ID_PROP_ID } from '../calendar-sync.constants';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
type FetchMock = jest.Mock<Promise<Response>, [string, RequestInit?]>;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function errorResponse(status: number, body = 'error'): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

const NOW = new Date('2026-07-12T00:00:00.000Z');
const ACCESS_TOKEN = 'graph.token';

const plainEvent = {
  id: 'evt-external-1',
  '@odata.etag': 'W/"etag-1"',
  subject: 'Standup',
  webLink: 'https://outlook.office.com/calendar/item/1',
  lastModifiedDateTime: '2026-07-10T09:00:00Z',
  isAllDay: false,
  start: { dateTime: '2026-07-15T09:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-07-15T09:30:00.0000000', timeZone: 'UTC' },
};

const ourEvent = {
  id: 'evt-ours-1',
  '@odata.etag': 'W/"etag-2"',
  subject: 'Launch day post',
  lastModifiedDateTime: '2026-07-11T09:00:00Z',
  start: { dateTime: '2026-07-16T09:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-07-16T09:30:00.0000000', timeZone: 'UTC' },
  singleValueExtendedProperties: [
    { id: GRAPH_POST_ID_PROP_ID, value: 'post-uuid-1' },
  ],
};

const removedEvent = { id: 'evt-gone-1', '@removed': { reason: 'deleted' } };

const DELTA_LINK =
  'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=abc123';

describe('fetchOutlookCalendarDelta', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = jest.fn<Promise<Response>, [string, RequestInit?]>();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('builds a bounded calendarView delta request with NO $expand (Graph rejects it on delta)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ value: [plainEvent], '@odata.deltaLink': DELTA_LINK }),
    );

    const result = await fetchOutlookCalendarDelta({
      accessToken: ACCESS_TOKEN,
      now: NOW,
    });

    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('/me/calendarView/delta?');
    expect(url).toContain(
      `startDateTime=${encodeURIComponent('2026-06-12T00:00:00.000Z')}`,
    );
    expect(url).toContain(
      `endDateTime=${encodeURIComponent('2026-10-10T00:00:00.000Z')}`,
    );
    // REGRESSION: Graph does not support $expand on delta endpoints — sending
    // `$expand=singleValueExtendedProperties(...)` 400s the request, which threw
    // out of the util and left the entire Outlook pull dead. Ownership comes from
    // `calendar_post_links` in CalendarPullSyncService instead.
    expect(decodeURIComponent(url)).not.toContain('$expand');
    expect(decodeURIComponent(url)).not.toContain(
      'singleValueExtendedProperties',
    );

    expect(result.needsFullResync).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.nextCursor).toBe(DELTA_LINK);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].isOurs).toBe(false);
    expect(result.changed[0].startsAt?.toISOString()).toBe(
      '2026-07-15T09:00:00.000Z',
    );
    expect(result.changed[0].htmlLink).toBe(
      'https://outlook.office.com/calendar/item/1',
    );
  });

  it('flags a page-cap truncation with `truncated` and hands back no cursor', async () => {
    // Every page keeps offering a nextLink → the cap is what stops us.
    fetchMock.mockResolvedValue(
      jsonResponse({
        value: [plainEvent],
        '@odata.nextLink':
          'https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=more',
      }),
    );

    const result = await fetchOutlookCalendarDelta({
      accessToken: ACCESS_TOKEN,
      now: NOW,
      maxPages: 2,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.truncated).toBe(true);
    expect(result.nextCursor).toBeUndefined();
    expect(result.needsFullResync).toBe(false);
  });

  it('reuses a stored deltaLink verbatim, follows nextLink pages, and returns the fresh deltaLink', async () => {
    const nextLink =
      'https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=page2';
    const freshDeltaLink =
      'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=xyz789';

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ value: [plainEvent], '@odata.nextLink': nextLink }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          value: [removedEvent],
          '@odata.deltaLink': freshDeltaLink,
        }),
      );

    const result = await fetchOutlookCalendarDelta({
      accessToken: ACCESS_TOKEN,
      cursor: DELTA_LINK,
      now: NOW,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(DELTA_LINK);
    expect(fetchMock.mock.calls[1][0]).toBe(nextLink);

    expect(result.nextCursor).toBe(freshDeltaLink);
    expect(result.changed).toHaveLength(1);
    expect(result.deleted).toEqual(['evt-gone-1']);
  });

  it('flags a 410 GONE deltaLink as needsFullResync', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(410, 'Gone'));

    const result = await fetchOutlookCalendarDelta({
      accessToken: ACCESS_TOKEN,
      cursor: DELTA_LINK,
      now: NOW,
    });

    expect(result.needsFullResync).toBe(true);
    expect(result.changed).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });

  it('flags a syncStateNotFound error as needsFullResync', async () => {
    fetchMock.mockResolvedValueOnce(
      errorResponse(
        400,
        JSON.stringify({
          error: { code: 'syncStateNotFound', message: 'Sync state not found' },
        }),
      ),
    );

    const result = await fetchOutlookCalendarDelta({
      accessToken: ACCESS_TOKEN,
      cursor: DELTA_LINK,
      now: NOW,
    });

    expect(result.needsFullResync).toBe(true);
  });

  it('flags an event carrying the schedura_post_id MAPI prop as isOurs (excluded from external import)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        value: [plainEvent, ourEvent],
        '@odata.deltaLink': DELTA_LINK,
      }),
    );

    const result = await fetchOutlookCalendarDelta({
      accessToken: ACCESS_TOKEN,
      now: NOW,
    });

    const ours = result.changed.find((e) => e.externalEventId === 'evt-ours-1');
    const external = result.changed.find(
      (e) => e.externalEventId === 'evt-external-1',
    );

    expect(ours?.isOurs).toBe(true);
    expect(ours?.postId).toBe('post-uuid-1');
    expect(external?.isOurs).toBe(false);
    // The pull service imports only the NOT-ours events.
    expect(result.changed.filter((e) => !e.isOurs)).toHaveLength(1);
  });

  it('routes @removed tombstones to `deleted`', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        value: [removedEvent, plainEvent],
        '@odata.deltaLink': DELTA_LINK,
      }),
    );

    const result = await fetchOutlookCalendarDelta({
      accessToken: ACCESS_TOKEN,
      cursor: DELTA_LINK,
      now: NOW,
    });

    expect(result.deleted).toEqual(['evt-gone-1']);
    expect(result.changed.map((e) => e.externalEventId)).toEqual([
      'evt-external-1',
    ]);
  });

  it('throws on a non-resync provider error', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(500, 'graph is down'));

    await expect(
      fetchOutlookCalendarDelta({ accessToken: ACCESS_TOKEN, now: NOW }),
    ).rejects.toThrow(/500/);
  });
});
