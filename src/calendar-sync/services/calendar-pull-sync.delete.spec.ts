// `CalendarPullSyncService` uses the module-level `db` singleton (not DI), so a
// Nest TestingModule can't intercept it — jest.mock the module and drive the
// exact query paths the external-DELETE write-back touches.
jest.mock('../../drizzle/db', () => {
  const selectResult: { rows: unknown[] } = { rows: [] };
  const deletedTables: unknown[] = [];
  return {
    __selectResult: selectResult,
    __deletedTables: deletedTables,
    db: {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => Promise.resolve(selectResult.rows)),
        })),
      })),
      delete: jest.fn((table: unknown) => {
        deletedTables.push(table);
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
import { posts } from '../../drizzle/schema/posts.schema';
import {
  calendarPostLinks,
  CalendarPostLink,
} from '../../drizzle/schema/calendar-sync.schema';
import { CalendarPushSyncService } from './calendar-push-sync.service';
import { CalendarPullSyncService } from './calendar-pull-sync.service';

// Handles onto the mocked db module's internals.
const dbMock = jest.requireMock('../../drizzle/db') as unknown as {
  __selectResult: { rows: unknown[] };
  __deletedTables: unknown[];
};

// The private write-back entry point under test.
interface PullSyncInternals {
  applyExternalDelete(link: CalendarPostLink): Promise<void>;
}

const LINK = {
  id: 'link-1',
  workspaceId: 'ws-1',
  channelId: 42,
  provider: 'google',
  postId: 'post-1',
  externalEventId: 'evt-1',
  externalCalendarId: 'primary',
  etag: 'etag-ours',
  lastPushedHash: 'hash-ours',
  lastExternalUpdatedAt: null,
  syncStatus: 'synced',
  lastError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as CalendarPostLink;

const SCHEDULED_POST = {
  id: 'post-1',
  workspaceId: 'ws-1',
  createdById: 'user-1',
  content: 'hello',
  status: 'scheduled',
  scheduledAt: new Date('2026-08-01T10:00:00.000Z'),
  updatedAt: new Date('2026-07-13T10:00:00.000Z'),
};

describe('CalendarPullSyncService — external delete → unschedule (never hard-delete)', () => {
  let internals: PullSyncInternals;
  let updatePost: jest.Mock;
  let syncPost: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    dbMock.__deletedTables.length = 0;
    dbMock.__selectResult.rows = [SCHEDULED_POST];

    updatePost = jest.fn().mockResolvedValue(SCHEDULED_POST);
    syncPost = jest.fn().mockResolvedValue(undefined);

    const channelService = {
      getAccessToken: jest.fn().mockResolvedValue('tok'),
    } as unknown as ChannelService;
    const pushSync = {
      syncPost,
    } as unknown as CalendarPushSyncService;
    const postService = { updatePost } as unknown as PostService;

    internals = new CalendarPullSyncService(
      channelService,
      {} as GoogleCalendarService,
      {} as OutlookCalendarService,
      pushSync,
      postService,
    ) as unknown as PullSyncInternals;
  });

  it('sends the post back to draft via PostService.updatePost({ scheduledAt: null })', async () => {
    await internals.applyExternalDelete(LINK);

    expect(updatePost).toHaveBeenCalledTimes(1);
    expect(updatePost).toHaveBeenCalledWith('post-1', 'ws-1', 'user-1', {
      scheduledAt: null,
    });
  });

  it('NEVER hard-deletes the post — only the calendar link row is deleted', async () => {
    await internals.applyExternalDelete(LINK);

    expect(dbMock.__deletedTables).toEqual([calendarPostLinks]);
    expect(dbMock.__deletedTables).not.toContain(posts);
  });

  it('does not touch an already-published post, and still drops the stale link', async () => {
    dbMock.__selectResult.rows = [{ ...SCHEDULED_POST, status: 'published' }];

    await internals.applyExternalDelete(LINK);

    expect(updatePost).not.toHaveBeenCalled();
    expect(dbMock.__deletedTables).toEqual([calendarPostLinks]);
  });

  it('drops the link (and nothing else) when the post no longer exists', async () => {
    dbMock.__selectResult.rows = [];

    await internals.applyExternalDelete(LINK);

    expect(updatePost).not.toHaveBeenCalled();
    expect(dbMock.__deletedTables).toEqual([calendarPostLinks]);
  });
});
