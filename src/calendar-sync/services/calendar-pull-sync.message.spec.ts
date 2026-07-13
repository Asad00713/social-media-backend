// `CalendarPullSyncService` uses the module-level `db` singleton (not DI), so a
// Nest TestingModule can't intercept it — jest.mock the module and drive the
// exact query paths the two-way write-back touches. Selects are keyed BY TABLE so
// the link lookup, the post lookup and the message lookup return different rows.
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

import { ChannelService } from '../../channels/services/channel.service';
import { GoogleCalendarService } from '../../channels/services/google-calendar.service';
import { OutlookCalendarService } from '../../channels/services/outlook-calendar.service';
import { PostService } from '../../posts/services/post.service';
import { ScheduledMessagesService } from '../../inbox/services/scheduled-messages.service';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import { posts } from '../../drizzle/schema/posts.schema';
import { scheduledInboxMessages } from '../../drizzle/schema/scheduled-inbox-messages.schema';
import { calendarItemLinks } from '../../drizzle/schema/calendar-sync.schema';
import { NormalizedExternalEvent } from '../providers/delta.types';
import { contentHash, messageToEventInput } from '../calendar-sync.mapper';
import { CalendarPushSyncService } from './calendar-push-sync.service';
import { CalendarPullSyncService } from './calendar-pull-sync.service';

const dbMock = jest.requireMock('../../drizzle/db') as unknown as {
  __state: {
    selectByTable: Map<unknown, unknown[]>;
    deletedTables: unknown[];
    updates: Array<{ table: unknown; set: Record<string, unknown> }>;
  };
};

// The private write-back entry point under test.
interface PullSyncInternals {
  applyOwnedChange(
    channel: unknown,
    event: NormalizedExternalEvent,
  ): Promise<void>;
}

const CHANNEL = {
  id: 42,
  workspaceId: 'ws-1',
  platform: 'google_calendar',
  isActive: true,
  connectionStatus: 'connected',
};

// Far enough out that MIN_RESCHEDULE_LEAD_MS (2 min) is comfortably satisfied.
const ORIGINAL_AT = new Date(Date.now() + 24 * 60 * 60 * 1000);
const MOVED_TO = new Date(Date.now() + 48 * 60 * 60 * 1000);
const APP_UPDATED_AT = new Date(Date.now() - 60 * 60 * 1000);
const EXTERNAL_UPDATED_AT = new Date(Date.now() - 60 * 1000); // newer than the app → apply_external

const POST_LINK = {
  id: 'link-1',
  workspaceId: 'ws-1',
  channelId: 42,
  provider: 'google',
  postId: 'post-1',
  messageId: null,
  externalEventId: 'evt-post',
  externalCalendarId: 'primary',
  etag: 'etag-ours',
  lastPushedHash: 'hash-ours',
  lastExternalUpdatedAt: null,
  syncStatus: 'synced',
  lastError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MESSAGE_LINK = {
  ...POST_LINK,
  id: 'link-2',
  postId: null,
  messageId: 'msg-1',
  externalEventId: 'evt-msg',
};

const SCHEDULED_POST = {
  id: 'post-1',
  workspaceId: 'ws-1',
  createdById: 'user-1',
  content: 'hello world',
  status: 'scheduled',
  scheduledAt: ORIGINAL_AT,
  updatedAt: APP_UPDATED_AT,
};

const PENDING_MESSAGE = {
  id: 'msg-1',
  workspaceId: 'ws-1',
  channelId: 42,
  text: 'thanks for the kind words!',
  targetLabel: '@alex',
  status: 'pending',
  scheduledAt: ORIGINAL_AT,
  updatedAt: APP_UPDATED_AT,
};

/** An inbound MOVE of an event we own: newer than the app, new start, new etag. */
function movedEvent(
  externalEventId: string,
  startsAt: Date = MOVED_TO,
): NormalizedExternalEvent {
  return {
    externalEventId,
    calendarId: 'primary',
    title: 'whatever the user renamed it to',
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
    isAllDay: false,
    externalUpdatedAt: EXTERNAL_UPDATED_AT,
    isOurs: true,
    etag: 'etag-theirs',
    raw: {},
  };
}

/** The `set` payloads of every UPDATE against `calendar_item_links`. */
function linkUpdates(): Array<Record<string, unknown>> {
  return dbMock.__state.updates
    .filter((u) => u.table === calendarItemLinks)
    .map((u) => u.set);
}

describe('CalendarPullSyncService — owned-event dispatch (post vs scheduled message)', () => {
  let internals: PullSyncInternals;
  let updatePost: jest.Mock;
  let updateFromCalendar: jest.Mock;
  let cancelFromCalendar: jest.Mock;
  let syncPost: jest.Mock;
  let syncMessage: jest.Mock;

  function seed(link: Record<string, unknown>) {
    dbMock.__state.selectByTable.set(socialMediaChannels, [CHANNEL]);
    dbMock.__state.selectByTable.set(calendarItemLinks, [link]);
    dbMock.__state.selectByTable.set(posts, [SCHEDULED_POST]);
    dbMock.__state.selectByTable.set(scheduledInboxMessages, [PENDING_MESSAGE]);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    dbMock.__state.selectByTable.clear();
    dbMock.__state.deletedTables.length = 0;
    dbMock.__state.updates.length = 0;

    updatePost = jest.fn().mockResolvedValue(SCHEDULED_POST);
    updateFromCalendar = jest.fn().mockResolvedValue({});
    cancelFromCalendar = jest.fn().mockResolvedValue({ success: true });
    syncPost = jest.fn().mockResolvedValue(undefined);
    syncMessage = jest.fn().mockResolvedValue(undefined);

    internals = new CalendarPullSyncService(
      {
        getAccessToken: jest.fn().mockResolvedValue('tok'),
      } as unknown as ChannelService,
      {} as GoogleCalendarService,
      {} as OutlookCalendarService,
      { syncPost, syncMessage } as unknown as CalendarPushSyncService,
      { updatePost } as unknown as PostService,
      {
        updateFromCalendar,
        cancelFromCalendar,
      } as unknown as ScheduledMessagesService,
    ) as unknown as PullSyncInternals;
  });

  // ===========================================================================
  // Post arc (LIVE behaviour — must be unchanged)
  // ===========================================================================

  it('routes a moved POST event to PostService.updatePost (never to the message path)', async () => {
    seed(POST_LINK);

    await internals.applyOwnedChange(CHANNEL, movedEvent('evt-post'));

    expect(updatePost).toHaveBeenCalledTimes(1);
    expect(updatePost).toHaveBeenCalledWith('post-1', 'ws-1', 'user-1', {
      scheduledAt: MOVED_TO,
    });
    expect(updateFromCalendar).not.toHaveBeenCalled();
    expect(cancelFromCalendar).not.toHaveBeenCalled();
  });

  // ===========================================================================
  // Message arc
  // ===========================================================================

  it('routes a moved MESSAGE event to ScheduledMessagesService.updateFromCalendar (re-arms the BullMQ job)', async () => {
    seed(MESSAGE_LINK);

    await internals.applyOwnedChange(CHANNEL, movedEvent('evt-msg'));

    expect(updateFromCalendar).toHaveBeenCalledTimes(1);
    expect(updateFromCalendar).toHaveBeenCalledWith('ws-1', 'msg-1', {
      scheduledAt: MOVED_TO.toISOString(),
    });
    expect(updatePost).not.toHaveBeenCalled();
  });

  it('pre-stamps the link with the MESSAGE body hash so the follow-up push is a no-op (echo suppression)', async () => {
    seed(MESSAGE_LINK);

    await internals.applyOwnedChange(CHANNEL, movedEvent('evt-msg'));

    const expectedHash = contentHash(
      messageToEventInput({
        id: PENDING_MESSAGE.id,
        workspaceId: PENDING_MESSAGE.workspaceId,
        text: PENDING_MESSAGE.text,
        targetLabel: PENDING_MESSAGE.targetLabel,
        scheduledAt: MOVED_TO,
      }),
    );

    const [stamp] = linkUpdates();
    expect(stamp).toMatchObject({
      etag: 'etag-theirs',
      lastPushedHash: expectedHash,
      syncStatus: 'synced',
    });
    // The stamp must land BEFORE the app-side update runs, or the push inside it
    // would see a stale hash and bounce the change back to the provider.
    expect(updateFromCalendar).toHaveBeenCalledTimes(1);
  });

  it('does not reschedule a non-pending message — it reconciles the stale event away instead', async () => {
    seed(MESSAGE_LINK);
    dbMock.__state.selectByTable.set(scheduledInboxMessages, [
      { ...PENDING_MESSAGE, status: 'sent' },
    ]);

    await internals.applyOwnedChange(CHANNEL, movedEvent('evt-msg'));

    expect(updateFromCalendar).not.toHaveBeenCalled();
    expect(syncMessage).toHaveBeenCalledWith('msg-1');
  });

  it('rejects a MESSAGE move that lands inside the 2-minute lead window', async () => {
    seed(MESSAGE_LINK);
    const tooSoon = new Date(Date.now() + 30 * 1000);

    await internals.applyOwnedChange(CHANNEL, movedEvent('evt-msg', tooSoon));

    expect(updateFromCalendar).not.toHaveBeenCalled();
    expect(linkUpdates().some((set) => set.syncStatus === 'error')).toBe(true);
  });

  it('skips the echo of our OWN write (matching etag) for a message link', async () => {
    seed(MESSAGE_LINK);
    const echo = { ...movedEvent('evt-msg'), etag: 'etag-ours' };

    await internals.applyOwnedChange(CHANNEL, echo);

    expect(updateFromCalendar).not.toHaveBeenCalled();
    expect(syncMessage).not.toHaveBeenCalled();
    expect(linkUpdates()).toHaveLength(0);
  });

  it('drops the link when the linked message no longer exists', async () => {
    seed(MESSAGE_LINK);
    dbMock.__state.selectByTable.set(scheduledInboxMessages, []);

    await internals.applyOwnedChange(CHANNEL, movedEvent('evt-msg'));

    expect(updateFromCalendar).not.toHaveBeenCalled();
    expect(dbMock.__state.deletedTables).toEqual([calendarItemLinks]);
  });
});
