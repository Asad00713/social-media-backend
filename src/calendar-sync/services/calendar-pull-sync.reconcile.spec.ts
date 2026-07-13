// `CalendarPullSyncService` uses the module-level `db` singleton (not DI), so a
// Nest TestingModule can't intercept it — jest.mock the module and record every
// write `reconcile()` performs. Selects are keyed BY TABLE so the channel lookup
// and the sync-state lookup can return different rows.
jest.mock('../../drizzle/db', () => {
  const state = {
    selectByTable: new Map<unknown, unknown[]>(),
    deletedTables: [] as unknown[],
    updates: [] as Array<{ table: unknown; set: Record<string, unknown> }>,
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
      insert: jest.fn(() => ({
        values: jest.fn(() => ({
          onConflictDoUpdate: jest.fn(() => Promise.resolve()),
        })),
      })),
      delete: jest.fn((table: unknown) => {
        state.deletedTables.push(table);
        return { where: jest.fn(() => Promise.resolve()) };
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
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import {
  calendarSyncState,
  externalCalendarEvents,
} from '../../drizzle/schema/calendar-sync.schema';
import { fetchGoogleCalendarDelta } from '../providers/google-delta.util';
import { CalendarDeltaResult } from '../providers/delta.types';
import { CalendarPushSyncService } from './calendar-push-sync.service';
import { CalendarPullSyncService } from './calendar-pull-sync.service';

const dbMock = jest.requireMock('../../drizzle/db') as unknown as {
  __state: {
    selectByTable: Map<unknown, unknown[]>;
    deletedTables: unknown[];
    updates: Array<{ table: unknown; set: Record<string, unknown> }>;
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

/** The `set` payloads of every UPDATE against `calendar_sync_state`. */
function syncStateUpdates(): Array<Record<string, unknown>> {
  return dbMock.__state.updates
    .filter((u) => u.table === calendarSyncState)
    .map((u) => u.set);
}

describe('CalendarPullSyncService.reconcile', () => {
  let service: CalendarPullSyncService;

  function seedState(over: Record<string, unknown> = {}) {
    dbMock.__state.selectByTable.set(socialMediaChannels, [CHANNEL]);
    dbMock.__state.selectByTable.set(calendarSyncState, [syncStateRow(over)]);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    dbMock.__state.selectByTable.clear();
    dbMock.__state.deletedTables.length = 0;
    dbMock.__state.updates.length = 0;

    const channelService = {
      getAccessToken: jest.fn().mockResolvedValue('tok'),
    } as unknown as ChannelService;
    const googleCalendarService = {
      getPrimaryCalendar: jest.fn().mockResolvedValue({ id: 'primary' }),
    } as unknown as GoogleCalendarService;

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
});
