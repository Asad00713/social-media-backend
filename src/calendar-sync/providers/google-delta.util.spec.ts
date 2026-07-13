import { fetchGoogleCalendarDelta } from './google-delta.util';
import { SCHEDURA_POST_ID_PROP } from '../calendar-sync.constants';

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
const ACCESS_TOKEN = 'ya29.token';

const plainEvent = {
  id: 'evt-external-1',
  status: 'confirmed',
  etag: '"etag-1"',
  summary: 'Dentist',
  htmlLink: 'https://calendar.google.com/event?eid=1',
  updated: '2026-07-10T09:00:00.000Z',
  start: { dateTime: '2026-07-15T09:00:00.000Z' },
  end: { dateTime: '2026-07-15T10:00:00.000Z' },
};

const ourEvent = {
  id: 'evt-ours-1',
  status: 'confirmed',
  etag: '"etag-2"',
  summary: 'Launch day post',
  updated: '2026-07-11T09:00:00.000Z',
  start: { dateTime: '2026-07-16T09:00:00.000Z' },
  end: { dateTime: '2026-07-16T09:30:00.000Z' },
  extendedProperties: {
    private: { [SCHEDURA_POST_ID_PROP]: 'post-uuid-1' },
  },
};

const cancelledEvent = { id: 'evt-gone-1', status: 'cancelled' };

describe('fetchGoogleCalendarDelta', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = jest.fn<Promise<Response>, [string, RequestInit?]>();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('runs a bounded full list when no cursor is stored and returns the next cursor', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [plainEvent], nextSyncToken: 'sync-token-1' }),
    );

    const result = await fetchGoogleCalendarDelta({
      accessToken: ACCESS_TOKEN,
      calendarId: 'primary',
      now: NOW,
    });

    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('singleEvents=true');
    // Bounded window: now-30d … now+90d.
    expect(url).toContain(
      `timeMin=${encodeURIComponent('2026-06-12T00:00:00.000Z')}`,
    );
    expect(url).toContain(
      `timeMax=${encodeURIComponent('2026-10-10T00:00:00.000Z')}`,
    );
    expect(url).not.toContain('syncToken');

    expect(result.needsFullResync).toBe(false);
    expect(result.truncated).toBe(false);
    // The syncToken MUST be captured on the first full sync — it is the only
    // thing that ever switches this connection onto the incremental stream.
    expect(result.nextCursor).toBe('sync-token-1');
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].externalEventId).toBe('evt-external-1');
    expect(result.changed[0].isOurs).toBe(false);
    expect(result.changed[0].startsAt?.toISOString()).toBe(
      '2026-07-15T09:00:00.000Z',
    );
  });

  // ---------------------------------------------------------------------------
  // Regression: Google OMITS `nextSyncToken` from any response whose request
  // carried `orderBy`. Sending it on the full list meant the cursor was never
  // minted → every run re-did a full list → no tombstones ever arrived → an
  // external delete never unscheduled the post.
  // ---------------------------------------------------------------------------
  it('NEVER sends orderBy on the full list (Google would then omit nextSyncToken)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [], nextSyncToken: 'sync-token-1' }),
    );

    await fetchGoogleCalendarDelta({ accessToken: ACCESS_TOKEN, now: NOW });

    expect(fetchMock.mock.calls[0][0]).not.toContain('orderBy');
  });

  it('sends showDeleted on BOTH the full and the incremental branch (stable parameter set)', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ items: [], nextSyncToken: 'sync-token-1' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ items: [], nextSyncToken: 'sync-token-2' }),
      );

    // Full (no cursor).
    await fetchGoogleCalendarDelta({ accessToken: ACCESS_TOKEN, now: NOW });
    // Incremental (cursor).
    await fetchGoogleCalendarDelta({
      accessToken: ACCESS_TOKEN,
      cursor: 'sync-token-1',
      now: NOW,
    });

    expect(fetchMock.mock.calls[0][0]).toContain('showDeleted=true');
    expect(fetchMock.mock.calls[1][0]).toContain('showDeleted=true');
  });

  it('flags a page-cap truncation with `truncated` and hands back no cursor', async () => {
    // Every page keeps offering a nextPageToken → the cap is what stops us.
    fetchMock.mockResolvedValue(
      jsonResponse({ items: [plainEvent], nextPageToken: 'more' }),
    );

    const result = await fetchGoogleCalendarDelta({
      accessToken: ACCESS_TOKEN,
      now: NOW,
      maxPages: 2,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.truncated).toBe(true);
    expect(result.nextCursor).toBeUndefined();
    expect(result.needsFullResync).toBe(false);
  });

  it('sends the stored sync token on an incremental run and advances the cursor across pages', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ items: [plainEvent], nextPageToken: 'page-2' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [cancelledEvent],
          nextSyncToken: 'sync-token-2',
        }),
      );

    const result = await fetchGoogleCalendarDelta({
      accessToken: ACCESS_TOKEN,
      calendarId: 'primary',
      cursor: 'sync-token-1',
      now: NOW,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = fetchMock.mock.calls[0][0];
    const secondUrl = fetchMock.mock.calls[1][0];
    expect(firstUrl).toContain('syncToken=sync-token-1');
    expect(firstUrl).toContain('showDeleted=true');
    expect(firstUrl).not.toContain('timeMin');
    expect(secondUrl).toContain('pageToken=page-2');

    // Cursor persisted for the next run is the token from the LAST page.
    expect(result.nextCursor).toBe('sync-token-2');
    expect(result.changed).toHaveLength(1);
    expect(result.deleted).toEqual(['evt-gone-1']);
  });

  it('flags a 410 GONE sync token as needsFullResync', async () => {
    fetchMock.mockResolvedValueOnce(
      errorResponse(410, 'Sync token is no longer valid'),
    );

    const result = await fetchGoogleCalendarDelta({
      accessToken: ACCESS_TOKEN,
      cursor: 'stale-token',
      now: NOW,
    });

    expect(result.needsFullResync).toBe(true);
    expect(result.changed).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });

  it('flags an event carrying schedura_post_id as isOurs (excluded from external import)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [plainEvent, ourEvent],
        nextSyncToken: 'sync-token-3',
      }),
    );

    const result = await fetchGoogleCalendarDelta({
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
    expect(external?.postId).toBeUndefined();
    // The pull service imports only the NOT-ours events.
    expect(result.changed.filter((e) => !e.isOurs)).toHaveLength(1);
  });

  it('routes cancelled events to `deleted`', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [cancelledEvent, plainEvent],
        nextSyncToken: 'sync-token-4',
      }),
    );

    const result = await fetchGoogleCalendarDelta({
      accessToken: ACCESS_TOKEN,
      cursor: 'sync-token-3',
      now: NOW,
    });

    expect(result.deleted).toEqual(['evt-gone-1']);
    expect(result.changed.map((e) => e.externalEventId)).toEqual([
      'evt-external-1',
    ]);
  });

  it('marks a date-only event as all-day', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [
          {
            id: 'evt-allday',
            status: 'confirmed',
            summary: 'Holiday',
            start: { date: '2026-07-20' },
            end: { date: '2026-07-21' },
          },
        ],
        nextSyncToken: 'sync-token-5',
      }),
    );

    const result = await fetchGoogleCalendarDelta({
      accessToken: ACCESS_TOKEN,
      now: NOW,
    });

    expect(result.changed[0].isAllDay).toBe(true);
    expect(result.changed[0].startsAt?.toISOString()).toBe(
      '2026-07-20T00:00:00.000Z',
    );
  });

  it('throws on a non-410 provider error', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(500, 'backend error'));

    await expect(
      fetchGoogleCalendarDelta({ accessToken: ACCESS_TOKEN, now: NOW }),
    ).rejects.toThrow(/500/);
  });
});
