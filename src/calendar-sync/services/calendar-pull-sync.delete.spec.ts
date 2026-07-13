// `CalendarPullSyncService` uses the module-level `db` singleton (not DI), so a
// Nest TestingModule can't intercept it — jest.mock the module and drive the
// exact query paths the external-DELETE write-back touches. Selects are keyed BY
// TABLE so the post lookup and the scheduled-message lookup return different rows.
jest.mock('../../drizzle/db', () => {
  const state = {
    selectByTable: new Map<unknown, unknown[]>(),
    deletedTables: [] as unknown[],
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
      update: jest.fn(() => ({
        set: jest.fn(() => ({ where: jest.fn(() => Promise.resolve()) })),
      })),
    },
  };
});

import { ChannelService } from '../../channels/services/channel.service';
import { GoogleCalendarService } from '../../channels/services/google-calendar.service';
import { OutlookCalendarService } from '../../channels/services/outlook-calendar.service';
import { PostService } from '../../posts/services/post.service';
import { ScheduledMessagesService } from '../../inbox/services/scheduled-messages.service';
import { posts } from '../../drizzle/schema/posts.schema';
import { scheduledInboxMessages } from '../../drizzle/schema/scheduled-inbox-messages.schema';
import {
  calendarItemLinks,
  CalendarItemLink,
} from '../../drizzle/schema/calendar-sync.schema';
import { CalendarPushSyncService } from './calendar-push-sync.service';
import { CalendarPullSyncService } from './calendar-pull-sync.service';

// Handles onto the mocked db module's internals.
const dbMock = jest.requireMock('../../drizzle/db') as unknown as {
  __state: {
    selectByTable: Map<unknown, unknown[]>;
    deletedTables: unknown[];
  };
};

// The private write-back entry point under test.
interface PullSyncInternals {
  applyExternalDelete(link: CalendarItemLink): Promise<void>;
}

const POST_LINK = {
  id: 'link-1',
  workspaceId: 'ws-1',
  channelId: 42,
  provider: 'google',
  postId: 'post-1',
  messageId: null,
  externalEventId: 'evt-1',
  externalCalendarId: 'primary',
  etag: 'etag-ours',
  lastPushedHash: 'hash-ours',
  lastExternalUpdatedAt: null,
  syncStatus: 'synced',
  lastError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as CalendarItemLink;

const MESSAGE_LINK = {
  ...POST_LINK,
  id: 'link-2',
  postId: null,
  messageId: 'msg-1',
  externalEventId: 'evt-2',
} as CalendarItemLink;

const SCHEDULED_POST = {
  id: 'post-1',
  workspaceId: 'ws-1',
  createdById: 'user-1',
  content: 'hello',
  status: 'scheduled',
  scheduledAt: new Date('2026-08-01T10:00:00.000Z'),
  updatedAt: new Date('2026-07-13T10:00:00.000Z'),
};

const PENDING_MESSAGE = {
  id: 'msg-1',
  workspaceId: 'ws-1',
  channelId: 42,
  text: 'thanks!',
  targetLabel: '@alex',
  status: 'pending',
  scheduledAt: new Date('2026-08-01T10:00:00.000Z'),
  updatedAt: new Date('2026-07-13T10:00:00.000Z'),
};

describe('CalendarPullSyncService — external delete write-back (never hard-delete)', () => {
  let internals: PullSyncInternals;
  let updatePost: jest.Mock;
  let cancelFromCalendar: jest.Mock;
  let syncPost: jest.Mock;
  let syncMessage: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    dbMock.__state.deletedTables.length = 0;
    dbMock.__state.selectByTable.clear();
    dbMock.__state.selectByTable.set(posts, [SCHEDULED_POST]);
    dbMock.__state.selectByTable.set(scheduledInboxMessages, [PENDING_MESSAGE]);

    updatePost = jest.fn().mockResolvedValue(SCHEDULED_POST);
    cancelFromCalendar = jest.fn().mockResolvedValue({ success: true });
    syncPost = jest.fn().mockResolvedValue(undefined);
    syncMessage = jest.fn().mockResolvedValue(undefined);

    const channelService = {
      getAccessToken: jest.fn().mockResolvedValue('tok'),
    } as unknown as ChannelService;
    const pushSync = {
      syncPost,
      syncMessage,
    } as unknown as CalendarPushSyncService;
    const postService = { updatePost } as unknown as PostService;
    const scheduledMessages = {
      cancelFromCalendar,
      updateFromCalendar: jest.fn(),
    } as unknown as ScheduledMessagesService;

    internals = new CalendarPullSyncService(
      channelService,
      {} as GoogleCalendarService,
      {} as OutlookCalendarService,
      pushSync,
      postService,
      scheduledMessages,
    ) as unknown as PullSyncInternals;
  });

  // ===========================================================================
  // Post arc (LIVE behaviour — must be unchanged)
  // ===========================================================================

  describe('post link', () => {
    it('sends the post back to draft via PostService.updatePost({ scheduledAt: null })', async () => {
      await internals.applyExternalDelete(POST_LINK);

      expect(updatePost).toHaveBeenCalledTimes(1);
      expect(updatePost).toHaveBeenCalledWith('post-1', 'ws-1', 'user-1', {
        scheduledAt: null,
      });
      expect(cancelFromCalendar).not.toHaveBeenCalled();
    });

    it('NEVER hard-deletes the post — only the calendar link row is deleted', async () => {
      await internals.applyExternalDelete(POST_LINK);

      expect(dbMock.__state.deletedTables).toEqual([calendarItemLinks]);
      expect(dbMock.__state.deletedTables).not.toContain(posts);
    });

    it('does not touch an already-published post, and still drops the stale link', async () => {
      dbMock.__state.selectByTable.set(posts, [
        { ...SCHEDULED_POST, status: 'published' },
      ]);

      await internals.applyExternalDelete(POST_LINK);

      expect(updatePost).not.toHaveBeenCalled();
      expect(dbMock.__state.deletedTables).toEqual([calendarItemLinks]);
    });

    it('drops the link (and nothing else) when the post no longer exists', async () => {
      dbMock.__state.selectByTable.set(posts, []);

      await internals.applyExternalDelete(POST_LINK);

      expect(updatePost).not.toHaveBeenCalled();
      expect(dbMock.__state.deletedTables).toEqual([calendarItemLinks]);
    });
  });

  // ===========================================================================
  // Message arc
  // ===========================================================================

  describe('scheduled-message link', () => {
    it('CANCELS the message via ScheduledMessagesService (reusing its BullMQ job removal)', async () => {
      await internals.applyExternalDelete(MESSAGE_LINK);

      expect(cancelFromCalendar).toHaveBeenCalledTimes(1);
      expect(cancelFromCalendar).toHaveBeenCalledWith('ws-1', 'msg-1');
      expect(updatePost).not.toHaveBeenCalled();
    });

    it('NEVER hard-deletes the message row — only the calendar link row is deleted', async () => {
      await internals.applyExternalDelete(MESSAGE_LINK);

      expect(dbMock.__state.deletedTables).toEqual([calendarItemLinks]);
      expect(dbMock.__state.deletedTables).not.toContain(
        scheduledInboxMessages,
      );
    });

    it('does not cancel an already-sent message, and still drops the stale link', async () => {
      dbMock.__state.selectByTable.set(scheduledInboxMessages, [
        { ...PENDING_MESSAGE, status: 'sent' },
      ]);

      await internals.applyExternalDelete(MESSAGE_LINK);

      expect(cancelFromCalendar).not.toHaveBeenCalled();
      expect(dbMock.__state.deletedTables).toEqual([calendarItemLinks]);
    });

    it('drops the link (and nothing else) when the message no longer exists', async () => {
      dbMock.__state.selectByTable.set(scheduledInboxMessages, []);

      await internals.applyExternalDelete(MESSAGE_LINK);

      expect(cancelFromCalendar).not.toHaveBeenCalled();
      expect(dbMock.__state.deletedTables).toEqual([calendarItemLinks]);
    });
  });
});
