import { BadRequestException } from '@nestjs/common';
import { OutlookCalendarService, PostEventData } from './outlook-calendar.service';

describe('OutlookCalendarService', () => {
  let service: OutlookCalendarService;
  const accessToken = 'test-access-token';

  const originalFetch = global.fetch;

  beforeEach(() => {
    service = new OutlookCalendarService();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  /** Build a mocked fetch Response-like object. */
  function mockFetch(
    body: unknown,
    { ok = true, status = 200 }: { ok?: boolean; status?: number } = {},
  ) {
    const fetchMock = jest.fn().mockResolvedValue({
      ok,
      status,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  describe('createPostEvent → Microsoft Graph event body mapping', () => {
    const postData: PostEventData = {
      postId: 'post-123',
      platforms: ['facebook', 'instagram'],
      caption: 'Hello world from Schedura',
      scheduledAt: new Date('2026-07-12T10:00:00.000Z'),
      workspaceName: 'Acme Co',
      mediaUrls: ['https://cdn.example.com/a.png'],
    };

    it('POSTs to /me/events with a Graph-shaped body', async () => {
      const fetchMock = mockFetch({
        id: 'evt-1',
        subject: '📘📸 Hello world from Schedura',
        body: { contentType: 'html', content: 'desc' },
        start: { dateTime: '2026-07-12T10:00:00.000', timeZone: 'UTC' },
        end: { dateTime: '2026-07-12T10:30:00.000', timeZone: 'UTC' },
        webLink: 'https://outlook.office365.com/evt-1',
      });

      const result = await service.createPostEvent(accessToken, postData);

      // Called the Graph events endpoint with a POST + bearer token
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://graph.microsoft.com/v1.0/me/events');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe(`Bearer ${accessToken}`);

      // Body maps to Graph schema (subject/body.contentType/start.dateTime+timeZone)
      const sent = JSON.parse(init.body);
      expect(sent.subject).toBe('📘📸 Hello world from Schedura');
      expect(sent.body.contentType).toBe('HTML');
      expect(sent.body.content).toContain('Hello world from Schedura');
      expect(sent.body.content).toContain('Post ID: post-123');
      // Graph carries tz separately → dateTime has NO trailing Z
      expect(sent.start.timeZone).toBe('UTC');
      expect(sent.start.dateTime).toBe('2026-07-12T10:00:00.000');
      expect(sent.start.dateTime).not.toMatch(/Z$/);
      // Default 30-minute duration
      expect(sent.end.dateTime).toBe('2026-07-12T10:30:00.000');

      // Response mapped back to Google-shaped CalendarEvent
      expect(result.id).toBe('evt-1');
      expect(result.summary).toBe('📘📸 Hello world from Schedura');
      expect(result.htmlLink).toBe('https://outlook.office365.com/evt-1');
    });
  });

  describe('error handling on non-ok fetch', () => {
    it('throws BadRequestException when Graph returns a non-ok response', async () => {
      mockFetch('Graph error: invalid token', { ok: false, status: 401 });

      await expect(
        service.createEvent(accessToken, {
          summary: 'x',
          startTime: new Date('2026-07-12T10:00:00.000Z'),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('listCalendars throws BadRequestException on non-ok response', async () => {
      mockFetch('nope', { ok: false, status: 500 });

      await expect(service.listCalendars(accessToken)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('deleteEvent swallows a 404 (already deleted)', async () => {
      mockFetch('', { ok: false, status: 404 });

      await expect(
        service.deleteEvent(accessToken, 'evt-x'),
      ).resolves.toBeUndefined();
    });

    it('verifyAccess returns false when fetch rejects', async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('network')) as unknown as typeof fetch;

      await expect(service.verifyAccess(accessToken)).resolves.toBe(false);
    });
  });

  describe('listCalendars mapping', () => {
    it('maps Graph calendars to Google-shaped Calendar objects', async () => {
      mockFetch({
        value: [
          { id: 'cal-1', name: 'Calendar', isDefaultCalendar: true, canEdit: true },
          { id: 'cal-2', name: 'Work', isDefaultCalendar: false, canEdit: false },
        ],
      });

      const calendars = await service.listCalendars(accessToken);
      expect(calendars).toHaveLength(2);
      expect(calendars[0]).toMatchObject({
        id: 'cal-1',
        summary: 'Calendar',
        primary: true,
        accessRole: 'writer',
      });
      expect(calendars[1].primary).toBe(false);
      expect(calendars[1].accessRole).toBe('reader');
    });
  });
});
