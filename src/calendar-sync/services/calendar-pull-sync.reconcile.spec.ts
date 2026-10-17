// `CalendarPullSyncService` uses the module-level `db` singleton (not DI), so a
// Nest TestingModule can't intercept it — jest.mock the module and record every
// write `reconcile()` performs. Selects are keyed BY TABLE so the channel lookup
// and the sync-state lookup can return different rows.
jest.mock('../../drizzle/db', () => {
  const state = {
    selectByTable: new Map<unknown, unknown[]>(),
    deletedTables: [] as unknown[],
    deleteConds: [] as unknown[],
    conflictTargets: [] as unknown[],
    updates: [] as Array<{ table: unknown; set: Record<string, unknown> }>,
    inserts: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  };
  return {
    __state: state,
    db: {
      select: jest.fn(() => ({
        from: jest.fn((table: unknown) => ({
          where: jest.fn(() =>
            Promise.resolve(state.selectByTable.get(table) ?? []),
          ),
        })),
      })),
      insert: jest.fn((table: unknown) => ({
        values: jest.fn((values: Record<string, unknown>) => {
          state.inserts.push({ table, values });
          return {
            onConflictDoUpdate: jest.fn((arg: { target: unknown }) => {
              state.conflictTargets.push(arg.target);
              return Promise.resolve();
            }),
          };
        }),
      })),
      delete: jest.fn((table: unknown) => {
        state.deletedTables.push(table);
        return {
          where: jest.fn((cond: unknown) => {
            state.deleteConds.push(cond);
            return Promise.resolve();
          }),
        };
      }),
      update: jest.fn((table: unknown) => ({
        set: jest.fn((values: Record<string, unknown>) => {
          state.updates.push({ table, set: values });
          return { where: jest.fn(() => Promise.resolve()) };
        }),
      })),
    },
  };
});

jest.mock('../providers/google-delta.util', () => ({
  fetchGoogleCalendarDelta: jest.fn(),
}));
jest.mock('../providers/outlook-delta.util', () => ({
  fetchOutlookCalendarDelta: jest.fn(),
}));

import { ChannelService } from '../../channels/services/channel.service';
import { GoogleCalendarService } from '../../channels/services/google-calendar.service';
import { OutlookCalendarService } from '../../channels/services/outlook-calendar.service';
import { PostService } from '../../posts/services/post.service';
import { ScheduledMessagesService } from '../../inbox/services/scheduled-messages.service';
import { AnalyticsEventEmitter } from '../../realtime/analytics-event-emitter.service';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import {
  calendarSyncState,
  externalCalendarEvents,
  externalCalendars,
  type ExternalCalendarRow,
} from '../../drizzle/schema/calendar-sync.schema';
import { fetchGoogleCalendarDelta } from '../providers/google-delta.util';
import {
  CalendarDeltaResult,
  NormalizedExternalEvent,
} from '../providers/delta.types';
import { CalendarPushSyncService } from './calendar-push-sync.service';
import { CalendarPullSyncService } from './calendar-pull-sync.service';
import { ExternalCalendarsService } from './external-calendars.service';

const dbMock = jest.requireMock('../../drizzle/db') as unknown as {
  __state: {
    selectByTable: Map<unknown, unknown[]>;
    deletedTables: unknown[];
    deleteConds: unknown[];
    conflictTargets: unknown[];
    updates: Array<{ table: unknown; set: Record<string, unknown> }>;
    inserts: Array<{ table: unknown; values: Record<string, unknown> }>;
  };
};

const fetchGoogleDeltaMock = fetchGoogleCalendarDelta as jest.MockedFunction<
  typeof fetchGoogleCalendarDelta
>;

const CHANNEL_ID = 42;
const DAY_MS = 24 * 60 * 60 * 1000;

const CHANNEL = {
  id: CHANNEL_ID,
  workspaceId: 'ws-1',
  platform: 'google_calendar',
  isActive: true,
  connectionStatus: 'connected',
};

/** A `calendar_sync_state` row with the cursor/full-sync age under test. */
function syncStateRow(over: Record<string, unknown> = {}) {
  return {
    id: 'state-1',
    channelId: CHANNEL_ID,
    provider: 'google',
    syncToken: null,
    deltaLink: null,
    lastFullSyncAt: null,
    lastIncrementalSyncAt: null,
    ...over,
  };
}

function deltaResult(
  over: Partial<CalendarDeltaResult> = {},
): CalendarDeltaResult {
  return {
    changed: [],
    deleted: [],
    nextCursor: 'fresh-token',
    needsFullResync: false,
    truncated: false,
    ...over,
  };
}

/** A plain inbound event the customer created on their own calendar. */
function externalEvent(externalEventId: string): NormalizedExternalEvent {
  return {
    externalEventId,
    calendarId: 'primary',
    title: 'Dentist',
    startsAt: new Date(Date.now() + DAY_MS),
    endsAt: new Date(Date.now() + DAY_MS + 30 * 60 * 1000),
    isAllDay: false,
    externalUpdatedAt: new Date(),
    isOurs: false,
    etag: 'etag-1',
    raw: {},
  };
}

/** An `external_calendars` row; the default is the connection primary. */
function calendarRow(
  over: Partial<ExternalCalendarRow> = {},
): ExternalCalendarRow {
  return {
    id: 'cal-primary',
    workspaceId: 'ws-1',
    channelId: CHANNEL_ID,
    providerCalendarId: 'primary',
    name: 'Me',
    color: null,
    isPrimary: true,
    accountEmail: null,
    syncToken: null,
    deltaLink: null,
    lastFullSyncAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

/** The `set` payloads of every UPDATE against `calendar_sync_state`. */
function syncStateUpdates(): Array<Record<string, unknown>> {
  return dbMock.__state.updates
    .filter((u) => u.table === calendarSyncState)
    .map((u) => u.set);
}

describe('CalendarPullSyncService.reconcile', () => {
  let service: CalendarPullSyncService;
  let emit: jest.Mock;
  let syncCalendarList: jest.Mock;
  let claimUnassignedEvents: jest.Mock;

  function seedState(over: Record<string, unknown> = {}) {
    dbMock.__state.selectByTable.set(socialMediaChannels, [CHANNEL]);
    dbMock.__state.selectByTable.set(calendarSyncState, [syncStateRow(over)]);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    dbMock.__state.selectByTable.clear();
    dbMock.__state.deletedTables.length = 0;
    dbMock.__state.deleteConds.length = 0;
    dbMock.__state.conflictTargets.length = 0;
    dbMock.__state.updates.length = 0;
    dbMock.__state.inserts.length = 0;

    const channelService = {
      getAccessToken: jest.fn().mockResolvedValue('tok'),
    } as unknown as ChannelService;
    const googleCalendarService = {
      getPrimaryCalendar: jest.fn().mockResolvedValue({ id: 'primary' }),
    } as unknown as GoogleCalendarService;

    emit = jest.fn();
    // The connection has only its primary calendar unless a test says more.
    claimUnassignedEvents = jest.fn().mockResolvedValue(undefined);
    syncCalendarList = jest.fn().mockResolvedValue({
      calendars: [calendarRow()],
      primaryIsNew: false,
    });

    service = new CalendarPullSyncService(
      channelService,
      googleCalendarService,
      {} as OutlookCalendarService,
      {
        syncPost: jest.fn(),
        syncMessage: jest.fn(),
      } as unknown as CalendarPushSyncService,
      { updatePost: jest.fn() } as unknown as PostService,
      {
        updateFromCalendar: jest.fn(),
        cancelFromCalendar: jest.fn(),
      } as unknown as ScheduledMessagesService,
      { emit } as unknown as AnalyticsEventEmitter,
      {
        syncCalendarList,
        claimUnassignedEvents,
      } as unknown as ExternalCalendarsService,
    );
  });

  // ===========================================================================
  // Page-cap truncation (a truncated run saw only a PREFIX of the stream)
  // ===========================================================================

  it('persists the cursor and prunes after a COMPLETE bounded full sync', async () => {
    seedState();
    fetchGoogleDeltaMock.mockResolvedValue(
      deltaResult({ nextCursor: 'fresh-token', truncated: false }),
    );

    await service.reconcile(CHANNEL_ID);

    // Prune ran (the full list is authoritative for the window).
    expect(dbMock.__state.deletedTables).toContain(externalCalendarEvents);

    const [set] = syncStateUpdates();
    expect(set.syncToken).toBe('fresh-token');
    expect(set.lastFullSyncAt).toBeInstanceOf(Date);
  });

  it('skips BOTH the prune and the cursor write when the run was TRUNCATED by the page cap', async () => {
    seedState();
    fetchGoogleDeltaMock.mockResolvedValue(
      deltaResult({ nextCursor: undefined, truncated: true }),
    );

    await service.reconcile(CHANNEL_ID);

    // A truncated page set is NOT evidence of deletion — pruning against it would
    // delete events that were merely never fetched.
    expect(dbMock.__state.deletedTables).not.toContain(externalCalendarEvents);

    const [set] = syncStateUpdates();
    expect(set).toBeDefined();
    expect(set.syncToken).toBeUndefined();
    // Not counted as a completed full sync either.
    expect(set.lastFullSyncAt).toBeUndefined();
  });

  it('never advances the cursor on a truncated INCREMENTAL run', async () => {
    seedState({ syncToken: 'old-token', lastFullSyncAt: new Date() });
    fetchGoogleDeltaMock.mockResolvedValue(
      deltaResult({ nextCursor: undefined, truncated: true }),
    );

    await service.reconcile(CHANNEL_ID);

    expect(dbMock.__state.deletedTables).not.toContain(externalCalendarEvents);
    const [set] = syncStateUpdates();
    expect(set.syncToken).toBeUndefined(); // 'old-token' stays put
  });

  // ===========================================================================
  // Periodic full resync (the cursor freezes the window it was minted with)
  // ===========================================================================

  it('keeps using a FRESH cursor (no forced resync inside the max-age window)', async () => {
    seedState({
      syncToken: 'old-token',
      lastFullSyncAt: new Date(Date.now() - 1 * DAY_MS),
    });
    fetchGoogleDeltaMock.mockResolvedValue(deltaResult());

    await service.reconcile(CHANNEL_ID);

    expect(fetchGoogleDeltaMock).toHaveBeenCalledTimes(1);
    expect(fetchGoogleDeltaMock.mock.calls[0][0].cursor).toBe('old-token');
  });

  it('drops a STALE cursor (>7d since the last full sync) and re-runs a bounded full list so the window rolls forward', async () => {
    seedState({
      syncToken: 'old-token',
      lastFullSyncAt: new Date(Date.now() - 8 * DAY_MS),
    });
    fetchGoogleDeltaMock.mockResolvedValue(deltaResult());

    await service.reconcile(CHANNEL_ID);

    // The cursor was cleared BEFORE the pull...
    expect(syncStateUpdates()[0]).toMatchObject({ syncToken: null });
    // ...and the pull ran WITHOUT it (a bounded full list around today's date).
    expect(fetchGoogleDeltaMock).toHaveBeenCalledTimes(1);
    expect(fetchGoogleDeltaMock.mock.calls[0][0].cursor).toBeNull();
    // ...and the fresh token from that full list is persisted.
    const last = syncStateUpdates().at(-1);
    expect(last).toMatchObject({ syncToken: 'fresh-token' });
    expect(last?.lastFullSyncAt).toBeInstanceOf(Date);
  });

  // ===========================================================================
  // Realtime signal — an open calendar view has no other way to learn that the
  // customer changed something on Google/Outlook.
  // ===========================================================================

  it('signals the workspace when the pull brought back changes', async () => {
    seedState();
    fetchGoogleDeltaMock.mockResolvedValue(
      deltaResult({ changed: [externalEvent('evt-1')], deleted: ['evt-gone'] }),
    );

    await service.reconcile(CHANNEL_ID);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('ws-1', 'calendar.external.changed', {
      workspaceId: 'ws-1',
      channelId: CHANNEL_ID,
      provider: 'google',
      changed: 1,
      deleted: 1,
    });
  });

  it('stays silent on a quiet poll — no change, no refetch', async () => {
    seedState();
    fetchGoogleDeltaMock.mockResolvedValue(deltaResult()); // changed: [], deleted: []

    await service.reconcile(CHANNEL_ID);

    expect(emit).not.toHaveBeenCalled();
  });

  // ===========================================================================
  // Every calendar of the connection (migration 0044)
  // ===========================================================================

  describe('calendar list and secondary calendars', () => {
    const SECONDARY = calendarRow({
      id: 'cal-team',
      providerCalendarId: 'team@group.test',
      name: 'Team',
      isPrimary: false,
    });

    const calendarUpdates = (): Array<Record<string, unknown>> =>
      dbMock.__state.updates
        .filter((u) => u.table === externalCalendars)
        .map((u) => u.set);

    const eventInserts = () =>
      dbMock.__state.inserts
        .filter((i) => i.table === externalCalendarEvents)
        .map((i) => i.values);

    const callFor = (providerCalendarId: string) =>
      fetchGoogleDeltaMock.mock.calls
        .map(([options]) => options)
        .find((options) => options.calendarId === providerCalendarId);

    function withCalendars(rows: ExternalCalendarRow[], primaryIsNew = false) {
      syncCalendarList.mockResolvedValue({ calendars: rows, primaryIsNew });
    }

    it('discovers the calendar list with the channel and a fresh token', async () => {
      seedState();
      fetchGoogleDeltaMock.mockResolvedValue(deltaResult());

      await service.reconcile(CHANNEL_ID);

      expect(syncCalendarList).toHaveBeenCalledWith(
        expect.objectContaining({
          id: CHANNEL_ID,
          workspaceId: 'ws-1',
          platform: 'google_calendar',
        }),
        'tok',
      );
    });

    it('clears the primary cursor once when the primary row is new, and backfills calendar_id', async () => {
      seedState({ syncToken: 'old-token', lastFullSyncAt: new Date() });
      withCalendars([calendarRow()], true);
      fetchGoogleDeltaMock.mockResolvedValue(deltaResult());

      await service.reconcile(CHANNEL_ID);

      const cleared = syncStateUpdates().filter((s) => s.syncToken === null);
      expect(cleared).toHaveLength(1);
      // The pull ran as a full list (no cursor) so every event gets calendar_id.
      expect(fetchGoogleDeltaMock.mock.calls[0][0].cursor).toBeNull();
      // Rows imported before 0044 are claimed by the primary calendar.
      expect(claimUnassignedEvents).toHaveBeenCalledWith(
        CHANNEL_ID,
        'primary',
        'cal-primary',
      );
    });

    it('does NOT clear a healthy primary cursor when the primary row already existed', async () => {
      seedState({ syncToken: 'old-token', lastFullSyncAt: new Date() });
      withCalendars([calendarRow()], false);
      fetchGoogleDeltaMock.mockResolvedValue(deltaResult());

      await service.reconcile(CHANNEL_ID);

      expect(fetchGoogleDeltaMock.mock.calls[0][0].cursor).toBe('old-token');
      expect(claimUnassignedEvents).not.toHaveBeenCalled();
    });

    it('stamps primary events with the primary calendar row and the attendee count', async () => {
      seedState();
      fetchGoogleDeltaMock.mockResolvedValue(
        deltaResult({
          changed: [{ ...externalEvent('evt-1'), attendeeCount: 4 }],
        }),
      );

      await service.reconcile(CHANNEL_ID);

      expect(eventInserts()).toEqual([
        expect.objectContaining({
          externalEventId: 'evt-1',
          calendarId: 'cal-primary',
          attendeeCount: 4,
        }),
      ]);
    });

    it('pulls a secondary calendar on its own id and cursor, as a non-primary stream', async () => {
      seedState();
      withCalendars([
        calendarRow(),
        { ...SECONDARY, syncToken: 'team-token', lastFullSyncAt: new Date() },
      ]);
      fetchGoogleDeltaMock.mockResolvedValue(deltaResult());

      await service.reconcile(CHANNEL_ID);

      expect(callFor('team@group.test')).toMatchObject({
        isPrimary: false,
        cursor: 'team-token',
      });
      expect(fetchGoogleDeltaMock.mock.calls[0][0].isPrimary).toBeUndefined();
    });

    it('upserts secondary events with that calendar and NEVER routes them through applyOwnedChange', async () => {
      seedState();
      withCalendars([calendarRow(), SECONDARY]);
      const owned = jest.spyOn(
        service as unknown as { applyOwnedChange: () => Promise<void> },
        'applyOwnedChange',
      );
      fetchGoogleDeltaMock.mockImplementation((options) =>
        Promise.resolve(
          options.calendarId === 'team@group.test'
            ? deltaResult({
                changed: [
                  externalEvent('team-evt'),
                  // Even a tagged lookalike is plain external data on a
                  // secondary calendar: Schedura only writes to the primary.
                  { ...externalEvent('team-tagged'), isOurs: true },
                ],
              })
            : deltaResult(),
        ),
      );

      await service.reconcile(CHANNEL_ID);

      expect(owned).not.toHaveBeenCalled();
      expect(
        eventInserts().map((v) => [v.externalEventId, v.calendarId]),
      ).toEqual([
        ['team-evt', 'cal-team'],
        ['team-tagged', 'cal-team'],
      ]);
    });

    it('keeps pulling the next calendar when one secondary calendar fails', async () => {
      const second = calendarRow({
        id: 'cal-two',
        providerCalendarId: 'two@group.test',
        isPrimary: false,
      });
      seedState();
      withCalendars([calendarRow(), SECONDARY, second]);
      fetchGoogleDeltaMock.mockImplementation((options) => {
        if (options.calendarId === 'team@group.test') {
          return Promise.reject(new Error('403 forbidden'));
        }
        return Promise.resolve(
          options.calendarId === 'two@group.test'
            ? deltaResult({ changed: [externalEvent('two-evt')] })
            : deltaResult(),
        );
      });

      await expect(service.reconcile(CHANNEL_ID)).resolves.toBeUndefined();

      expect(fetchGoogleDeltaMock).toHaveBeenCalledTimes(3);
      expect(eventInserts().map((v) => v.calendarId)).toEqual(['cal-two']);
    });

    it('drops a secondary cursor older than 7 days (from last_full_sync_at) and re-lists', async () => {
      seedState();
      withCalendars([
        calendarRow(),
        {
          ...SECONDARY,
          syncToken: 'team-token',
          lastFullSyncAt: new Date(Date.now() - 8 * DAY_MS),
        },
      ]);
      fetchGoogleDeltaMock.mockResolvedValue(deltaResult());

      await service.reconcile(CHANNEL_ID);

      expect(callFor('team@group.test')?.cursor).toBeNull();
      expect(calendarUpdates()[0]).toMatchObject({ syncToken: null });
    });

    it('keeps a secondary cursor that had a full sync within 7 days', async () => {
      seedState();
      withCalendars([
        calendarRow(),
        {
          ...SECONDARY,
          syncToken: 'team-token',
          lastFullSyncAt: new Date(Date.now() - 1 * DAY_MS),
        },
      ]);
      fetchGoogleDeltaMock.mockResolvedValue(deltaResult());

      await service.reconcile(CHANNEL_ID);

      expect(callFor('team@group.test')?.cursor).toBe('team-token');
    });

    it('stores a secondary cursor on its own row, not on calendar_sync_state', async () => {
      seedState({ syncToken: 'primary-token', lastFullSyncAt: new Date() });
      withCalendars([calendarRow(), SECONDARY]);
      fetchGoogleDeltaMock.mockImplementation((options) =>
        Promise.resolve(
          deltaResult({
            nextCursor:
              options.calendarId === 'team@group.test'
                ? 'team-fresh'
                : 'primary-fresh',
          }),
        ),
      );

      await service.reconcile(CHANNEL_ID);

      const stored = calendarUpdates().at(-1);
      expect(stored).toMatchObject({ syncToken: 'team-fresh' });
      expect(stored?.lastFullSyncAt).toBeInstanceOf(Date);
      expect(syncStateUpdates().at(-1)).toMatchObject({
        syncToken: 'primary-fresh',
      });
    });

    it('prunes a secondary calendar only after a COMPLETE full list', async () => {
      seedState({ syncToken: 'primary-token', lastFullSyncAt: new Date() });
      withCalendars([calendarRow(), SECONDARY]);
      fetchGoogleDeltaMock.mockImplementation((options) =>
        Promise.resolve(
          options.calendarId === 'team@group.test'
            ? deltaResult({ nextCursor: undefined, truncated: true })
            : deltaResult(),
        ),
      );

      await service.reconcile(CHANNEL_ID);
      expect(dbMock.__state.deletedTables).not.toContain(
        externalCalendarEvents,
      );

      fetchGoogleDeltaMock.mockResolvedValue(deltaResult());
      await service.reconcile(CHANNEL_ID);
      expect(dbMock.__state.deletedTables).toContain(externalCalendarEvents);
    });

    it('counts secondary changes in the realtime signal', async () => {
      seedState();
      withCalendars([calendarRow(), SECONDARY]);
      fetchGoogleDeltaMock.mockImplementation((options) =>
        Promise.resolve(
          options.calendarId === 'team@group.test'
            ? deltaResult({ changed: [externalEvent('team-evt')] })
            : deltaResult(),
        ),
      );

      await service.reconcile(CHANNEL_ID);

      expect(emit).toHaveBeenCalledWith(
        'ws-1',
        'calendar.external.changed',
        expect.objectContaining({ changed: 1 }),
      );
    });

    it('keys an event upsert on (channel, calendar, event) so one meeting on two calendars is two rows', async () => {
      seedState();
      fetchGoogleDeltaMock.mockResolvedValue(
        deltaResult({ changed: [externalEvent('evt-1')] }),
      );

      await service.reconcile(CHANNEL_ID);

      expect(dbMock.__state.conflictTargets).toEqual([
        [
          externalCalendarEvents.channelId,
          externalCalendarEvents.externalCalendarId,
          externalCalendarEvents.externalEventId,
        ],
      ]);
    });

    it('scopes a primary tombstone to the primary calendar, so a secondary copy survives', async () => {
      seedState({ syncToken: 'tok', lastFullSyncAt: new Date() });
      fetchGoogleDeltaMock.mockResolvedValue(
        deltaResult({ deleted: ['shared-evt'] }),
      );

      await service.reconcile(CHANNEL_ID);

      const dialect = new PgDialect();
      const params = dbMock.__state.deleteConds.map(
        (c) => dialect.sqlToQuery(c as SQL).params,
      );
      expect(params).toContainEqual(
        expect.arrayContaining([CHANNEL_ID, 'primary', 'shared-evt']),
      );
    });

    it('still pulls the primary calendar when the calendar list sync throws', async () => {
      seedState();
      syncCalendarList.mockRejectedValue(new Error('db down'));
      fetchGoogleDeltaMock.mockResolvedValue(
        deltaResult({ changed: [externalEvent('evt-1')] }),
      );

      await expect(service.reconcile(CHANNEL_ID)).resolves.toBeUndefined();

      expect(fetchGoogleDeltaMock).toHaveBeenCalledTimes(1);
      expect(eventInserts()).toHaveLength(1);
    });
  });
});
