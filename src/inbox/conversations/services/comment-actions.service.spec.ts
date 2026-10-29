import {
  BadRequestException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
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

/**
 * The service writes metadata as one SQL jsonb patch. Render it and apply the
 * same semantics to the fake row (the real SQL is proven in
 * comment-actions.db.spec.ts): merge params[0], then likeCount + params[1]
 * floored at 0.
 */
function applyMetadata(
  row: InboxItem | undefined,
  value: unknown,
): Record<string, unknown> {
  const base = row?.metadata ?? {};
  if (
    typeof value !== 'object' ||
    value === null ||
    !('queryChunks' in value)
  ) {
    return value as Record<string, unknown>;
  }
  const { params } = new PgDialect().sqlToQuery(value as SQL);
  const patch = JSON.parse(params[0] as string) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...base, ...patch };
  if (typeof params[1] === 'number') {
    const current = typeof base.likeCount === 'number' ? base.likeCount : 0;
    out.likeCount = Math.max(0, current + params[1]);
  }
  return out;
}

/** The JSON patch a metadata write carried. */
function patchOf(update: Record<string, unknown>): Record<string, unknown> {
  const { params } = new PgDialect().sqlToQuery(update.metadata as SQL);
  return JSON.parse(params[0] as string) as Record<string, unknown>;
}

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
  const findConversation = jest.fn().mockResolvedValue({ id: 'dm-looked-up' });
  const updates: Array<Record<string, unknown>> = [];
  // The hidden-reply count behind the returned node: select().from().where().
  const countHidden = jest.fn<Promise<number>, []>().mockResolvedValue(0);
  // No `transaction` on purpose: the service must never open one (D1).
  const db = {
    select: jest.fn(() => ({
      from: () => ({
        where: () => countHidden().then((n) => [{ n }]),
      }),
    })),
    query: {
      inboxItems: { findFirst: jest.fn().mockResolvedValue(row) },
      socialMediaChannels: { findFirst: jest.fn().mockResolvedValue(channel) },
      users: { findFirst: jest.fn().mockResolvedValue(undefined) },
      inboxConversations: { findFirst: findConversation },
    },
    update: jest.fn(() => ({
      set: (values: Record<string, unknown>) => {
        calls.push('db.update');
        updates.push(values);
        return {
          where: () => ({
            returning: () =>
              Promise.resolve([
                {
                  ...row,
                  ...values,
                  ...(values.metadata === undefined
                    ? {}
                    : { metadata: applyMetadata(row, values.metadata) }),
                },
              ]),
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
  const getAccessToken = jest.fn().mockResolvedValue('tok');
  const channels = { getAccessToken };
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
    getAccessToken,
    db,
    findConversation,
    countHidden,
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
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

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
      expect(patchOf(t.updates[0])).toMatchObject({ likeUri: 'at://like/1' });

      const t2 = setup(
        itemRow({
          platform: 'bluesky',
          metadata: { likedByUs: true, likeUri: 'at://like/1' },
        }),
        channelRow({ platform: 'bluesky' }),
      );
      await t2.service.like(WS, 'item-1', USER, false);
      expect(patchOf(t2.updates[0])).toMatchObject({ likeUri: null });
    });
  });

  describe('the returned node on Bluesky at the hidden-reply cap', () => {
    const blueskyRow = () => itemRow({ platform: 'bluesky' });
    const blueskyChannel = () => channelRow({ platform: 'bluesky' });

    it('carries the cap reason on its hide action at 300 hidden replies', async () => {
      const t = setup(blueskyRow(), blueskyChannel());
      t.countHidden.mockResolvedValue(300);
      const out = await t.service.like(WS, 'item-1', USER, true);
      expect(out.node.actions.hide).toEqual({
        allowed: false,
        reason: 'Bluesky allows 300 hidden replies per post',
      });
      expect(t.countHidden).toHaveBeenCalledTimes(1);
    });

    it('still offers hide below the cap', async () => {
      const t = setup(blueskyRow(), blueskyChannel());
      t.countHidden.mockResolvedValue(299);
      const out = await t.service.like(WS, 'item-1', USER, true);
      expect(out.node.actions.hide.allowed).toBe(true);
    });

    it('does not count on other platforms', async () => {
      const t = setup(itemRow());
      await t.service.like(WS, 'item-1', USER, true);
      expect(t.countHidden).not.toHaveBeenCalled();
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
      expect(t.updates[0]).toMatchObject({ status: 'done', text: '[deleted]' });
      expect(patchOf(t.updates[0])).toMatchObject({ deletedByUserId: USER });
      expect(patchOf(t.updates[0]).deletedAt).toEqual(expect.any(String));
      // a patch, not the whole object: other keys are not rewritten
      expect(patchOf(t.updates[0])).not.toHaveProperty('keep');
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
      expect(patchOf(t.updates[0]).privateReplySentAt).toEqual(
        expect.any(String),
      );
      // the comment's own conversation is told which comment changed
      expect(t.realtime.timelineAppended).toHaveBeenCalledWith(
        WS,
        'comment-conv',
        null,
        'item-1',
      );
    });

    it('writes privateReplySentAt BEFORE the DM row (feeds the comment flag; moving it later must fail)', async () => {
      const t = setup(itemRow());
      t.inbox.upsertDm.mockImplementation(() => {
        t.calls.push('upsertDm');
        return Promise.resolve(null);
      });
      t.sync.syncThread.mockImplementation(() => {
        t.calls.push('syncThread');
        return Promise.resolve({ conversationId: 'c' } as Awaited<
          ReturnType<ConversationSyncService['syncThread']>
        >);
      });
      await t.service.privateReply(WS, 'item-1', USER, 'hi');
      expect(t.calls.indexOf('db.update')).toBeGreaterThan(-1);
      expect(t.calls.indexOf('db.update')).toBeLessThan(
        t.calls.indexOf('upsertDm'),
      );
      expect(t.calls.indexOf('upsertDm')).toBeLessThan(
        t.calls.indexOf('syncThread'),
      );
    });

    it('a failing DM sync after delivery is still 200: resync queued, comment refreshed, id looked up', async () => {
      const t = setup(itemRow());
      t.sync.syncThread.mockImplementation((_ws, key) =>
        key === '5:page-1:psid-9'
          ? Promise.reject(new Error('db down'))
          : Promise.resolve({ conversationId: 'comment-conv' } as Awaited<
              ReturnType<ConversationSyncService['syncThread']>
            >),
      );
      const out = await t.service.privateReply(WS, 'item-1', USER, 'hi');
      expect(out).toEqual({ conversationId: 'dm-looked-up' });
      expect(t.resync.enqueue).toHaveBeenCalledWith(
        WS,
        '5:page-1:psid-9',
        expect.objectContaining({ kind: 'outbound', userId: USER }),
      );
      expect(t.realtime.timelineAppended).toHaveBeenCalledWith(
        WS,
        'comment-conv',
        null,
        'item-1',
      );
    });

    it('queues the DM resync WITH the outbound intent and the sending user', async () => {
      const sentAt = new Date('2026-10-01T10:00:00Z');
      const t = setup(itemRow());
      t.adapter.sendPrivateReply.mockResolvedValueOnce({
        recipientPlatformId: 'psid-9',
        platformItemId: 'm-1',
        platformCreatedAt: sentAt,
      });
      t.sync.syncThread.mockImplementation((_ws, key) =>
        key === '5:page-1:psid-9'
          ? Promise.reject(new Error('db down'))
          : Promise.resolve({ conversationId: 'comment-conv' } as Awaited<
              ReturnType<ConversationSyncService['syncThread']>
            >),
      );
      await t.service.privateReply(WS, 'item-1', USER, 'hi');
      expect(t.resync.enqueue).toHaveBeenCalledWith(WS, '5:page-1:psid-9', {
        kind: 'outbound',
        userId: USER,
        markDone: false,
        at: sentAt,
      });
    });

    it('a failing upsertDm after delivery is still 200 and returns null when no conversation exists yet', async () => {
      const t = setup(itemRow());
      t.inbox.upsertDm.mockRejectedValueOnce(new Error('insert failed'));
      t.findConversation.mockResolvedValue(undefined);
      const out = await t.service.privateReply(WS, 'item-1', USER, 'hi');
      expect(out).toEqual({ conversationId: null });
      expect(t.resync.enqueue).toHaveBeenCalledWith(
        WS,
        '5:page-1:psid-9',
        expect.objectContaining({ kind: 'outbound', userId: USER }),
      );
    });

    it('a delivered private reply with no recipient id is 200 null: guard written, resyncs queued, warned, no DM row', async () => {
      const t = setup(itemRow());
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      t.adapter.sendPrivateReply.mockResolvedValueOnce({
        recipientPlatformId: null,
        platformItemId: 'm-1',
        platformCreatedAt: new Date(),
      });
      const out = await t.service.privateReply(WS, 'item-1', USER, 'hi');
      expect(out).toEqual({ conversationId: null });
      expect(patchOf(t.updates[0]).privateReplySentAt).toEqual(
        expect.any(String),
      );
      expect(t.inbox.upsertDm).not.toHaveBeenCalled();
      expect(t.resync.enqueue).toHaveBeenCalledWith(WS, '5:post-1');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('item-1'));
    });

    it('a platform that sent no message id skips the DM row but still syncs and answers 200', async () => {
      const t = setup(itemRow());
      t.adapter.sendPrivateReply.mockResolvedValueOnce({
        recipientPlatformId: 'psid-9',
        platformItemId: null,
        platformCreatedAt: new Date(),
      });
      const out = await t.service.privateReply(WS, 'item-1', USER, 'hi');
      expect(t.inbox.upsertDm).not.toHaveBeenCalled();
      expect(out).toEqual({ conversationId: 'conv-1' });
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

  describe('errors raised while talking to the platform (I2)', () => {
    async function errOf(p: Promise<unknown>): Promise<InboxSendError> {
      const e: unknown = await p.catch((x: unknown) => x);
      expect(e).toBeInstanceOf(InboxSendError);
      return e as InboxSendError;
    }

    it('an expired-token BadRequest from token resolution is 409 CHANNEL_DISCONNECTED', async () => {
      const t = setup(itemRow());
      t.getAccessToken.mockRejectedValueOnce(
        new BadRequestException(
          'Access token has expired. Please reconnect this channel.',
        ),
      );
      const e = await errOf(t.service.hide(WS, 'item-1', USER, true));
      expect(e.getStatus()).toBe(409);
      expect(e.getResponse()).toMatchObject({ code: 'CHANNEL_DISCONNECTED' });
      expect(t.updates).toHaveLength(0);
    });

    it('a plan-locked 403 passes through, not REPLY_WINDOW_CLOSED', async () => {
      const t = setup(itemRow());
      const locked = new ForbiddenException('Channel locked by your plan');
      t.getAccessToken.mockRejectedValueOnce(locked);
      await expect(t.service.hide(WS, 'item-1', USER, true)).rejects.toBe(
        locked,
      );
    });

    it("a platform service's BadRequest (own-comment delete on Bluesky) is 502 PLATFORM_ERROR", async () => {
      const t = setup(
        itemRow({ platform: 'bluesky', fromMe: true }),
        channelRow({ platform: 'bluesky' }),
      );
      t.adapter.deleteComment.mockRejectedValueOnce(
        new BadRequestException('Failed to delete post from Bluesky'),
      );
      const e = await errOf(t.service.delete(WS, 'item-1', USER));
      expect(e.getStatus()).toBe(502);
      expect(e.getResponse()).toMatchObject({ code: 'PLATFORM_ERROR' });
    });

    it('a deliberate 400 { reason } from an adapter (Bluesky 300 cap) is kept', async () => {
      const t = setup(
        itemRow({ platform: 'bluesky' }),
        channelRow({ platform: 'bluesky' }),
      );
      const cap = new BadRequestException({ reason: 'Up to 300 replies' });
      t.adapter.hideComment.mockRejectedValueOnce(cap);
      await expect(t.service.hide(WS, 'item-1', USER, true)).rejects.toBe(cap);
    });
  });

  describe('a failing row update after the platform call succeeded', () => {
    function failingUpdates(t: ReturnType<typeof setup>) {
      (t.db.update as jest.Mock).mockImplementation(() => {
        throw new Error('db blip');
      });
    }

    it('like: still returns the node, queues a resync, no 500', async () => {
      const t = setup(itemRow());
      failingUpdates(t);
      const out = await t.service.like(WS, 'item-1', USER, true);
      expect(out.node.id).toBe('item-1');
      expect(t.adapter.likeComment).toHaveBeenCalledTimes(1);
      expect(t.resync.enqueue).toHaveBeenCalledWith(WS, '5:post-1');
    });

    it('hide: still succeeds and queues a resync', async () => {
      const t = setup(itemRow());
      failingUpdates(t);
      await expect(
        t.service.hide(WS, 'item-1', USER, true),
      ).resolves.toMatchObject({ success: true });
      expect(t.resync.enqueue).toHaveBeenCalledWith(WS, '5:post-1');
    });

    it('delete: still succeeds and queues a resync', async () => {
      const t = setup(itemRow({ fromMe: true }));
      failingUpdates(t);
      await expect(t.service.delete(WS, 'item-1', USER)).resolves.toMatchObject(
        { ok: true },
      );
      expect(t.resync.enqueue).toHaveBeenCalledWith(WS, '5:post-1');
    });
  });

  describe('adapter without the method', () => {
    it.each([
      ['like', 'likeComment'],
      ['hide', 'hideComment'],
      ['privateReply', 'sendPrivateReply'],
      ['delete', 'moderateDelete'],
    ] as const)(
      '%s with no %s is 400 with the fallback reason',
      async (action, method) => {
        const t = setup(itemRow());
        (t.adapter as Record<string, unknown>)[method] = undefined;
        const call =
          action === 'like'
            ? t.service.like(WS, 'item-1', USER, true)
            : action === 'hide'
              ? t.service.hide(WS, 'item-1', USER, true)
              : action === 'privateReply'
                ? t.service.privateReply(WS, 'item-1', USER, 'x')
                : t.service.delete(WS, 'item-1', USER);
        await expect(reasonOf(call)).resolves.toEqual({
          reason: DISALLOWED_FALLBACK,
        });
      },
    );
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
