import { ExternalEventsService } from './external-events.service';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  title: 'Standup',
  startsAt: new Date('2026-03-02T09:00:00Z'),
  endsAt: new Date('2026-03-02T09:30:00Z'),
  isAllDay: false,
  htmlLink: null,
  platform: 'google_calendar',
  calendarId: 'cal-1',
  calendarName: 'Work',
  calendarColor: '#039be5',
  accountEmail: 'a@example.test',
  attendeeCount: null,
  channelAccountName: 'Connection',
  ...over,
});

function serviceWith(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where']) {
    chain[m] = jest.fn(() => chain);
  }
  chain.orderBy = jest.fn(() => Promise.resolve(rows));
  const db = { select: jest.fn(() => chain) };
  return new ExternalEventsService(db as never);
}

const list = (svc: ExternalEventsService) =>
  svc.listExternalEvents('ws', '2026-03-01T00:00:00Z', '2026-03-31T00:00:00Z');

describe('ExternalEventsService serialisation', () => {
  it('falls back to the connection name when calendar_id is NULL', async () => {
    const [dto] = await list(
      serviceWith([
        row({
          calendarId: null,
          calendarName: null,
          calendarColor: null,
          accountEmail: null,
        }),
      ]),
    );
    expect(dto).toMatchObject({
      calendarId: null,
      calendarName: 'Connection',
      calendarColor: null,
      accountEmail: null,
    });
  });

  it('serialises a null title as an empty string', async () => {
    const [dto] = await list(serviceWith([row({ title: null })]));
    expect(dto.title).toBe('');
  });

  it('returns the attendee count and the calendar fields', async () => {
    const [dto] = await list(serviceWith([row({ attendeeCount: 4 })]));
    expect(dto).toMatchObject({
      attendeeCount: 4,
      calendarId: 'cal-1',
      calendarName: 'Work',
      calendarColor: '#039be5',
      accountEmail: 'a@example.test',
    });
  });
});

describe('ExternalEventsService range cap', () => {
  const svc = () => serviceWith([]);

  it('allows exactly 100 days', async () => {
    await expect(
      svc().listExternalEvents(
        'ws',
        '2026-01-01T00:00:00Z',
        '2026-04-11T00:00:00Z',
      ),
    ).resolves.toEqual([]);
  });

  it('refuses a window longer than 100 days with a 400', async () => {
    await expect(
      svc().listExternalEvents(
        'ws',
        '2026-01-01T00:00:00Z',
        '2026-04-12T00:00:00Z',
      ),
    ).rejects.toMatchObject({
      status: 400,
      message: 'The calendar range is limited to 100 days',
    });
  });
});
