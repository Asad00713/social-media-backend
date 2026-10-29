import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DbType } from '../../../drizzle/db';
import type { InboxItem } from '../../../drizzle/schema/inbox.schema';
import type { SocialMediaChannel } from '../../../drizzle/schema/channels.schema';
import type { ChannelService } from '../../../channels/services/channel.service';
import type { AnalyticsEventEmitter } from '../../../realtime/analytics-event-emitter.service';
import type { PlatformInboxAdapter } from '../../adapters/inbox-adapter.interface';
import type { InboxDispatcher } from '../../services/inbox-dispatcher.service';
import type { InboxService } from '../../inbox.service';
import { DISALLOWED_FALLBACK } from '../lib/comment-actions';
import { InboxSendError } from '../lib/send-error';
import type { ConversationResyncService } from './conversation-resync.service';
import type { ConversationSyncService } from './conversation-sync.service';
import type { InboxRealtimeService } from './inbox-realtime.service';
import { CommentActionsService } from './comment-actions.service';

const WS = 'ws-1';
const USER = 'user-1';
const DAY = 24 * 60 * 60 * 1000;

function itemRow(over: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'item-1',
    workspaceId: WS,
    channelId: 5,
    platform: 'facebook',
    type: 'comment',
    platformItemId: 'c-1',
    platformParentId: null,
    platformPostId: 'post-1',
    conversationId: null,
    ourPostId: null,
    authorPlatformId: 'psid-9',
    authorHandle: 'alice',
    authorDisplayName: 'Alice',
    authorAvatarUrl: null,
    text: 'hello',
    status: 'unread',
    fromMe: false,
    isHidden: false,
    isMention: false,
    platformCreatedAt: new Date(Date.now() - DAY),
    fetchedAt: new Date(),
    repliedByUserId: null,
    repliedAt: null,
    authoredByUserId: null,
    metadata: {},
    archivedAt: null,
    threadKey: '5:post-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as InboxItem;
}

function channelRow(
  over: Partial<SocialMediaChannel> = {},
): SocialMediaChannel {
  return {
    id: 5,
    workspaceId: WS,
    platform: 'facebook',
    platformAccountId: 'page-1',
    accountName: 'Acme Page',
    username: 'acme',
    profilePictureUrl: null,
    connectionStatus: 'connected',
    metadata: {},
    ...over,
  } as SocialMediaChannel;
}

function setup(row: InboxItem | undefined, channel = channelRow()) {
  const calls: string[] = [];
  const updates: Array<Record<string, unknown>> = [];
  // No `transaction` on purpose: the service must never open one (D1).
  const db = {
    query: {
      inboxItems: { findFirst: jest.fn().mockResolvedValue(row) },
      socialMediaChannels: { findFirst: jest.fn().mockResolvedValue(channel) },
      users: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
    update: jest.fn(() => ({
      set: (values: Record<string, unknown>) => {
        calls.push('db.update');
        updates.push(values);
        return {
          where: () => ({
            returning: () => Promise.resolve([{ ...row, ...values }]),
          }),
        };
      },
    })),
  } as unknown as DbType;

  const adapter = {
    likeComment: jest.fn().mockImplementation(() => {
      calls.push('adapter');
      return Promise.resolve({ likeRef: null });
    }),
    hideComment: jest.fn().mockImplementation(() => {
      calls.push('adapter');
      return Promise.resolve();
    }),
    deleteComment: jest.fn().mockImplementation(() => {
      calls.push('adapter');
      return Promise.resolve(true);
    }),
    moderateDelete: jest.fn().mockImplementation(() => {
      calls.push('adapter');
      return Promise.resolve();
    }),
    sendPrivateReply: jest.fn().mockImplementation(() => {
      calls.push('adapter');
      return Promise.resolve({
        recipientPlatformId: 'psid-9',
        platformItemId: 'm-1',
        platformCreatedAt: new Date(),
      });
    }),
  };
  const dispatcher = {
    get: jest.fn().mockReturnValue(adapter as unknown as PlatformInboxAdapter),
  };
  const channels = {
    getAccessToken: jest.fn().mockResolvedValue('tok'),
  };
  const inbox = {
    upsertDm: jest.fn().mockResolvedValue(null),
  };
  const sync = {
    syncThread: jest.fn().mockResolvedValue({ conversationId: 'conv-1' }),
  };
  const resync = {
    enqueue: jest.fn().mockResolvedValue(undefined),
  };
  const realtime = {
    timelineAppended: jest.fn(),
  };
  const emitter = {
    emit: jest.fn(),
  };

  const service = new CommentActionsService(
    db,
    channels as unknown as ChannelService,
    dispatcher as unknown as InboxDispatcher,
    inbox as unknown as InboxService,
    sync as unknown as ConversationSyncService,
    resync as unknown as ConversationResyncService,
    realtime as unknown as InboxRealtimeService,
    emitter as unknown as AnalyticsEventEmitter,
  );
  return {
    service,
    adapter,
    dispatcher,
    channels,
    inbox,
    sync,
    resync,
    realtime,
    emitter,
    updates,
    calls,
  };
}

async function reasonOf(p: Promise<unknown>): Promise<unknown> {
  const err: unknown = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BadRequestException);
  return (err as BadRequestException).getResponse();
}

describe('CommentActionsService', () => {
  describe('every action', () => {
    it('404s for an item outside the workspace', async () => {
      const t = setup(undefined);
      await expect(
        t.service.like(WS, 'nope', USER, true),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(t.adapter.likeComment).not.toHaveBeenCalled();
    });

    it('404s for a DM row', async () => {
      const t = setup(itemRow({ type: 'dm' }));
      await expect(
        t.service.hide(WS, 'item-1', USER, true),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('like', () => {
    it("400s with the flag's reason on Instagram and never calls the adapter", async () => {
      const t = setup(
        itemRow({ platform: 'instagram' }),
        channelRow({ platform: 'instagram' }),
      );
      await expect(
        reasonOf(t.service.like(WS, 'item-1', USER, true)),
      ).resolves.toEqual({
        reason: "Instagram doesn't let apps like comments",
      });
      expect(t.adapter.likeComment).not.toHaveBeenCalled();
      expect(t.updates).toHaveLength(0);
    });

    it('likes on Facebook: adapter called, likedByUs true, likeCount +1', async () => {
      const t = setup(itemRow({ metadata: { likeCount: 4 } }));
      const out = await t.service.like(WS, 'item-1', USER, true);
      expect(t.adapter.likeComment).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: 'tok',
          platformAccountId: 'page-1',
        }),
        { platformItemId: 'c-1', metadata: { likeCount: 4 } },
        true,
      );
      expect(out.node.likedByUs).toBe(true);
      expect(out.node.likeCount).toBe(5);
    });

    it('unlike decrements and never goes below 0', async () => {
      const t = setup(itemRow({ metadata: { likedByUs: true, likeCount: 0 } }));
      const out = await t.service.like(WS, 'item-1', USER, false);
      expect(out.node.likedByUs).toBe(false);
      expect(out.node.likeCount).toBe(0);

      const t2 = setup(
        itemRow({ metadata: { likedByUs: true, likeCount: 3 } }),
      );
      expect(
        (await t2.service.like(WS, 'item-1', USER, false)).node.likeCount,
      ).toBe(2);
    });

    it('does not double count a like that is already ours', async () => {
      const t = setup(itemRow({ metadata: { likedByUs: true, likeCount: 3 } }));
      expect(
        (await t.service.like(WS, 'item-1', USER, true)).node.likeCount,
      ).toBe(3);
    });

    it('keeps the platform like reference and drops it on unlike', async () => {
      const t = setup(
        itemRow({ platform: 'bluesky', platformItemId: 'at://p/1' }),
        channelRow({ platform: 'bluesky' }),
      );
      t.adapter.likeComment.mockResolvedValueOnce({ likeRef: 'at://like/1' });
      await t.service.like(WS, 'item-1', USER, true);
      expect(t.updates[0].metadata).toMatchObject({ likeUri: 'at://like/1' });

      const t2 = setup(
        itemRow({
          platform: 'bluesky',
          metadata: { likedByUs: true, likeUri: 'at://like/1' },
        }),
        channelRow({ platform: 'bluesky' }),
      );
      await t2.service.like(WS, 'item-1', USER, false);
      expect(t2.updates[0].metadata).toMatchObject({ likeUri: null });
    });
  });

  describe('hide', () => {
    it('hides on the platform, stores isHidden, resyncs and keeps the legacy body', async () => {
      const t = setup(itemRow());
      const out = await t.service.hide(WS, 'item-1', USER, true);
      expect(t.adapter.hideComment).toHaveBeenCalledWith(
        expect.objectContaining({ accessToken: 'tok' }),
        'c-1',
        true,
      );
      expect(t.updates[0]).toMatchObject({ isHidden: true });
      expect(t.sync.syncThread).toHaveBeenCalledWith(WS, '5:post-1');
      expect(out).toMatchObject({ success: true, isHidden: true });
      expect(out.node.isHidden).toBe(true);
      expect(t.emitter.emit).toHaveBeenCalledWith(
        WS,
        'inbox.item.updated',
        expect.objectContaining({ id: 'item-1', changes: { isHidden: true } }),
      );
    });

    it('400s on YouTube with its reason', async () => {
      const t = setup(
        itemRow({ platform: 'youtube' }),
        channelRow({ platform: 'youtube' }),
      );
      await expect(
        reasonOf(t.service.hide(WS, 'item-1', USER, true)),
      ).resolves.toEqual({ reason: "YouTube doesn't allow it" });
    });
  });

  describe('delete', () => {
    it("someone else's YouTube comment goes through moderateDelete, not deleteComment", async () => {
      const t = setup(
        itemRow({ platform: 'youtube', fromMe: false }),
        channelRow({ platform: 'youtube' }),
      );
      const out = await t.service.delete(WS, 'item-1', USER);
      expect(t.adapter.moderateDelete).toHaveBeenCalledTimes(1);
      expect(t.adapter.deleteComment).not.toHaveBeenCalled();
      expect(out).toMatchObject({ ok: true, success: true });
      expect(typeof out.deletedAt).toBe('string');
    });

    it('our own comment goes through deleteComment and is soft deleted', async () => {
      const t = setup(itemRow({ fromMe: true, metadata: { keep: 1 } }));
      await t.service.delete(WS, 'item-1', USER);
      expect(t.adapter.deleteComment).toHaveBeenCalledTimes(1);
      expect(t.adapter.moderateDelete).not.toHaveBeenCalled();
      expect(t.updates[0]).toMatchObject({
        status: 'done',
        text: '[deleted]',
        metadata: { keep: 1, deletedByUserId: USER },
      });
      expect(
        (t.updates[0].metadata as Record<string, unknown>).deletedAt,
      ).toEqual(expect.any(String));
      expect(t.sync.syncThread).toHaveBeenCalledWith(WS, '5:post-1');
    });

    it("someone else's Bluesky comment is 400 with the fallback reason", async () => {
      const t = setup(
        itemRow({ platform: 'bluesky', fromMe: false }),
        channelRow({ platform: 'bluesky' }),
      );
      await expect(
        reasonOf(t.service.delete(WS, 'item-1', USER)),
      ).resolves.toEqual({
        reason: DISALLOWED_FALLBACK,
      });
      expect(t.adapter.moderateDelete).not.toHaveBeenCalled();
      expect(t.adapter.deleteComment).not.toHaveBeenCalled();
    });

    it('refuses an already deleted comment', async () => {
      const t = setup(
        itemRow({ metadata: { deletedAt: new Date().toISOString() } }),
      );
      await expect(
        reasonOf(t.service.delete(WS, 'item-1', USER)),
      ).resolves.toEqual({
        reason: DISALLOWED_FALLBACK,
      });
    });
  });

  describe('privateReply', () => {
    it('replies to a 3-day-old Facebook comment and returns the synced conversation id', async () => {
      const t = setup(
        itemRow({ platformCreatedAt: new Date(Date.now() - 3 * DAY) }),
      );
      t.sync.syncThread.mockImplementation((_ws, key) =>
        Promise.resolve({
          conversationId:
            key === '5:page-1:psid-9' ? 'dm-conv' : 'comment-conv',
        } as Awaited<ReturnType<ConversationSyncService['syncThread']>>),
      );

      const out = await t.service.privateReply(WS, 'item-1', USER, 'thanks!');

      expect(t.adapter.sendPrivateReply).toHaveBeenCalledWith(
        expect.objectContaining({ accessToken: 'tok' }),
        'c-1',
        'thanks!',
      );
      expect(t.inbox.upsertDm).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: WS,
          channelId: 5,
          conversationId: 'page-1:psid-9',
          platformItemId: 'm-1',
          fromMe: true,
          text: 'thanks!',
          authoredByUserId: USER,
        }),
      );
      expect(out).toEqual({ conversationId: 'dm-conv' });
      expect(t.updates[0].metadata).toMatchObject({
        privateReplySentAt: expect.any(String) as string,
      });
      // the comment's own conversation is told which comment changed
      expect(t.realtime.timelineAppended).toHaveBeenCalledWith(
        WS,
        'comment-conv',
        null,
        'item-1',
      );
    });

    it('a second private reply is 400 with the fallback reason', async () => {
      const t = setup(
        itemRow({ metadata: { privateReplySentAt: new Date().toISOString() } }),
      );
      await expect(
        reasonOf(t.service.privateReply(WS, 'item-1', USER, 'again')),
      ).resolves.toEqual({ reason: DISALLOWED_FALLBACK });
      expect(t.adapter.sendPrivateReply).not.toHaveBeenCalled();
    });

    it('is 400 for a comment older than 7 days', async () => {
      const t = setup(
        itemRow({ platformCreatedAt: new Date(Date.now() - 8 * DAY) }),
      );
      await expect(
        reasonOf(t.service.privateReply(WS, 'item-1', USER, 'late')),
      ).resolves.toEqual({ reason: DISALLOWED_FALLBACK });
    });
  });

  describe('platform failures and ordering', () => {
    it('maps a platform error to 502 PLATFORM_ERROR and writes nothing', async () => {
      const t = setup(itemRow());
      t.adapter.likeComment.mockRejectedValueOnce(new Error('(#100) bad id'));
      const err: unknown = await t.service
        .like(WS, 'item-1', USER, true)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InboxSendError);
      expect((err as InboxSendError).getStatus()).toBe(502);
      expect((err as InboxSendError).getResponse()).toMatchObject({
        code: 'PLATFORM_ERROR',
        message: '(#100) bad id',
      });
      expect(t.updates).toHaveLength(0);
      expect(t.realtime.timelineAppended).not.toHaveBeenCalled();
    });

    it('a disconnected channel is 409 CHANNEL_DISCONNECTED and the platform is not called', async () => {
      const t = setup(
        itemRow(),
        channelRow({ connectionStatus: 'disconnected' }),
      );
      const err: unknown = await t.service
        .hide(WS, 'item-1', USER, true)
        .catch((e: unknown) => e);
      expect((err as InboxSendError).getStatus()).toBe(409);
      expect((err as InboxSendError).getResponse()).toMatchObject({
        code: 'CHANNEL_DISCONNECTED',
      });
      expect(t.adapter.hideComment).not.toHaveBeenCalled();
    });

    it('calls the platform first, then writes, then announces (no transaction open across HTTP)', async () => {
      const t = setup(itemRow());
      t.realtime.timelineAppended.mockImplementation(() => {
        t.calls.push('realtime');
      });
      await t.service.hide(WS, 'item-1', USER, true);
      expect(t.calls).toEqual(['adapter', 'db.update', 'realtime']);
    });

    it('queues a resync when the sync fails, and still succeeds', async () => {
      const t = setup(itemRow());
      t.sync.syncThread.mockRejectedValueOnce(new Error('db down'));
      await expect(
        t.service.hide(WS, 'item-1', USER, true),
      ).resolves.toMatchObject({
        success: true,
      });
      expect(t.resync.enqueue).toHaveBeenCalledWith(WS, '5:post-1');
      expect(t.realtime.timelineAppended).not.toHaveBeenCalled();
    });

    it('announces timelineAppended with the comment id after success', async () => {
      const t = setup(itemRow());
      await t.service.like(WS, 'item-1', USER, true);
      expect(t.realtime.timelineAppended).toHaveBeenCalledWith(
        WS,
        'conv-1',
        null,
        'item-1',
      );
    });
  });
});
