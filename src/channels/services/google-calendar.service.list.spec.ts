import { GoogleCalendarService } from './google-calendar.service';

describe('GoogleCalendarService.listCalendarsComplete', () => {
  afterEach(() => jest.restoreAllMocks());

  it('asks for hidden calendars too, so hiding one in Google never drops its row', async () => {
    const fetchMock = jest.fn<Promise<unknown>, [string]>().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ items: [{ id: 'a' }] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await new GoogleCalendarService().listCalendarsComplete('t');

    expect(fetchMock.mock.calls[0][0]).toContain('showHidden=true');
    expect(result).toEqual({ calendars: [{ id: 'a' }], complete: true });
  });

  it('reports an incomplete list when pages remain after the cap', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ items: [], nextPageToken: 'more' }),
    }) as unknown as typeof fetch;

    const result = await new GoogleCalendarService().listCalendarsComplete('t');

    expect(result.complete).toBe(false);
  });
});
