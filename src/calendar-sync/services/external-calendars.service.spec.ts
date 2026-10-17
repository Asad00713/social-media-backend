import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import type { ExternalCalendarRow } from '../../drizzle/schema/calendar-sync.schema';
import type { Calendar } from '../../channels/services/google-calendar.service';
import { GoogleCalendarService } from '../../channels/services/google-calendar.service';
import { OutlookCalendarService } from '../../channels/services/outlook-calendar.service';
import {
  ExternalCalendarsService,
  MAX_CALENDARS_PER_CONNECTION,
} from './external-calendars.service';

const dialect = new PgDialect();
const CHANNEL = { id: 7, workspaceId: 'ws-1', platform: 'google_calendar' };

function row(over: Partial<ExternalCalendarRow> = {}): ExternalCalendarRow {
  return {
    id: 'row-x',
    workspaceId: 'ws-1',
    channelId: 7,
    providerCalendarId: 'x',
    name: 'X',
    color: null,
    isPrimary: false,
    accountEmail: null,
    syncToken: null,
    deltaLink: null,
    lastFullSyncAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

/**
 * A recording fake of the four drizzle chains the service uses. `select`
 * returns whatever rows are seeded; `delete` reports the ids it was asked to
 * remove (read back out of the rendered SQL params).
 */
function fakeDb(seed: ExternalCalendarRow[]) {
  const state = {
    seed,
    inserted: [] as ExternalCalendarRow[],
    updates: [] as Array<Record<string, unknown>>,
    deletedIds: [] as string[],
    nextId: 1,
  };
  const db = {
    select: () => ({ from: () => ({ where: () => Promise.resolve(seed) }) }),
    insert: () => ({
      values: (v: Partial<ExternalCalendarRow>) => ({
        onConflictDoNothing: () => ({
          returning: () => {
            const created = row({ id: `new-${state.nextId++}`, ...v });
            state.inserted.push(created);
            return Promise.resolve([created]);
          },
        }),
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => {
          state.updates.push(v);
          return Promise.resolve();
        },
      }),
    }),
    delete: () => ({
      where: (cond: SQL) => {
        state.deletedIds.push(...(dialect.sqlToQuery(cond).params as string[]));
        return Promise.resolve();
      },
    }),
  };
  return { db: db as unknown as DbType, state };
}

function cal(id: string, over: Partial<Calendar> = {}): Calendar {
  return { id, summary: id.toUpperCase(), ...over };
}

function build(seed: ExternalCalendarRow[] = []) {
  const google = {
    listCalendarsComplete: jest.fn(),
  };
  const outlook = {
    listCalendarsComplete: jest.fn(),
    getAccountEmail: jest.fn().mockResolvedValue('me@outlook.test'),
  };
  const { db, state } = fakeDb(seed);
  const service = new ExternalCalendarsService(
    db,
    google as unknown as GoogleCalendarService,
    outlook as unknown as OutlookCalendarService,
  );
  return { service, google, outlook, state };
}

describe('ExternalCalendarsService.syncCalendarList', () => {
  it('creates a row per calendar, the primary first, with name, colour and is_primary', async () => {
    const { service, google, state } = build();
    google.listCalendarsComplete.mockResolvedValue({
      complete: true,
      calendars: [
        cal('team@x.test', { backgroundColor: '#0b8043' }),
        cal('me@x.test', { primary: true, backgroundColor: '#9fe1e7' }),
        cal('holidays'),
      ],
    });

    const result = await service.syncCalendarList(CHANNEL, 'tok');

    expect(state.inserted.map((r) => r.providerCalendarId)).toEqual([
      'me@x.test',
      'team@x.test',
      'holidays',
    ]);
    expect(state.inserted[0]).toMatchObject({
      isPrimary: true,
      color: '#9fe1e7',
      name: 'ME@X.TEST',
      workspaceId: 'ws-1',
      channelId: 7,
    });
    expect(state.inserted[1].isPrimary).toBe(false);
    expect(result.calendars[0].providerCalendarId).toBe('me@x.test');
    expect(result.primaryIsNew).toBe(true);
  });

  it('flags primaryIsNew only on the call that creates the primary row', async () => {
    const { service, google } = build([
      row({ id: 'r1', providerCalendarId: 'me@x.test', isPrimary: true }),
    ]);
    google.listCalendarsComplete.mockResolvedValue({
      complete: true,
      calendars: [cal('me@x.test', { primary: true }), cal('team')],
    });

    const result = await service.syncCalendarList(CHANNEL, 'tok');

    expect(result.primaryIsNew).toBe(false);
  });

  it('never creates more than the cap, and still creates the primary', async () => {
    const { service, google, state } = build();
    const many = Array.from({ length: 40 }, (_, i) => cal(`c${i}`));
    google.listCalendarsComplete.mockResolvedValue({
      complete: true,
      calendars: [...many, cal('primary-cal', { primary: true })],
    });

    await service.syncCalendarList(CHANNEL, 'tok');

    expect(state.inserted).toHaveLength(MAX_CALENDARS_PER_CONNECTION);
    expect(state.inserted[0].providerCalendarId).toBe('primary-cal');
  });

  it('keeps an existing row that the provider reordered past the cap', async () => {
    const seed = Array.from({ length: MAX_CALENDARS_PER_CONNECTION }, (_, i) =>
      row({ id: `r${i}`, providerCalendarId: `c${i}`, name: `C${i}` }),
    );
    const { service, google, state } = build(seed);
    // 30 NEW calendars now sort ahead of the 25 we already hold.
    const fresh = Array.from({ length: 30 }, (_, i) => cal(`new${i}`));
    const old = seed.map((r) => cal(r.providerCalendarId, { summary: r.name }));
    google.listCalendarsComplete.mockResolvedValue({
      complete: true,
      calendars: [...fresh, ...old],
    });

    const result = await service.syncCalendarList(CHANNEL, 'tok');

    expect(state.deletedIds).toEqual([]);
    expect(state.inserted).toHaveLength(0); // no free slot
    expect(result.calendars).toHaveLength(MAX_CALENDARS_PER_CONNECTION);
    expect(result.calendars.map((r) => r.providerCalendarId).sort()).toEqual(
      seed.map((r) => r.providerCalendarId).sort(),
    );
  });

  it('deletes a calendar the provider no longer lists, after a complete list', async () => {
    const { service, google, state } = build([
      row({ id: 'keep', providerCalendarId: 'me@x.test', isPrimary: true }),
      row({ id: 'gone', providerCalendarId: 'old-team' }),
    ]);
    google.listCalendarsComplete.mockResolvedValue({
      complete: true,
      calendars: [cal('me@x.test', { primary: true })],
    });

    const result = await service.syncCalendarList(CHANNEL, 'tok');

    expect(state.deletedIds).toEqual(['gone']);
    expect(result.calendars.map((r) => r.id)).toEqual(['keep']);
  });

  it('deletes nothing when the list request fails', async () => {
    const { service, google, state } = build([
      row({ id: 'a', providerCalendarId: 'a' }),
      row({ id: 'b', providerCalendarId: 'b' }),
    ]);
    google.listCalendarsComplete.mockRejectedValue(new Error('503'));

    const result = await service.syncCalendarList(CHANNEL, 'tok');

    expect(state.deletedIds).toEqual([]);
    expect(result.calendars).toHaveLength(2);
    expect(result.primaryIsNew).toBe(false);
  });

  it('deletes nothing when the list is partial (more pages than the walk read)', async () => {
    const { service, google, state } = build([
      row({ id: 'a', providerCalendarId: 'a' }),
      row({ id: 'b', providerCalendarId: 'b' }),
    ]);
    google.listCalendarsComplete.mockResolvedValue({
      complete: false,
      calendars: [cal('a')],
    });

    await service.syncCalendarList(CHANNEL, 'tok');

    expect(state.deletedIds).toEqual([]);
  });

  it('deletes nothing when a "successful" list is empty', async () => {
    const { service, google, state } = build([
      row({ id: 'a', providerCalendarId: 'a' }),
    ]);
    google.listCalendarsComplete.mockResolvedValue({
      complete: true,
      calendars: [],
    });

    await service.syncCalendarList(CHANNEL, 'tok');

    expect(state.deletedIds).toEqual([]);
  });

  it('takes the Google account email from a primary id that contains "@"', async () => {
    const { service, google, outlook, state } = build();
    google.listCalendarsComplete.mockResolvedValue({
      complete: true,
      calendars: [cal('me@x.test', { primary: true }), cal('team')],
    });

    await service.syncCalendarList(CHANNEL, 'tok');

    expect(state.inserted.map((r) => r.accountEmail)).toEqual([
      'me@x.test',
      'me@x.test',
    ]);
    expect(outlook.getAccountEmail).not.toHaveBeenCalled();
  });

  it('leaves the email empty for a Google primary id without "@"', async () => {
    const { service, google, state } = build();
    google.listCalendarsComplete.mockResolvedValue({
      complete: true,
      calendars: [cal('primary-id', { primary: true })],
    });

    await service.syncCalendarList(CHANNEL, 'tok');

    expect(state.inserted[0].accountEmail).toBeNull();
  });

  it('asks Graph for the Outlook account email', async () => {
    const { service, outlook, state } = build();
    outlook.listCalendarsComplete.mockResolvedValue({
      complete: true,
      calendars: [cal('AAMk1', { primary: true })],
    });

    await service.syncCalendarList(
      { ...CHANNEL, platform: 'outlook_calendar' },
      'tok',
    );

    expect(outlook.getAccountEmail).toHaveBeenCalledWith('tok');
    expect(state.inserted[0].accountEmail).toBe('me@outlook.test');
  });

  it('updates a row only when something about the calendar changed', async () => {
    const { service, google, state } = build([
      row({
        id: 'r1',
        providerCalendarId: 'me@x.test',
        name: 'ME@X.TEST',
        isPrimary: true,
        accountEmail: 'me@x.test',
      }),
      row({
        id: 'r2',
        providerCalendarId: 'team',
        name: 'Old name',
        accountEmail: 'me@x.test',
      }),
    ]);
    google.listCalendarsComplete.mockResolvedValue({
      complete: true,
      calendars: [
        cal('me@x.test', { primary: true }),
        cal('team', { summary: 'Team' }),
      ],
    });

    await service.syncCalendarList(CHANNEL, 'tok');

    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({ name: 'Team' });
  });
});
