import type { PoolClient } from 'pg';
import type { DbType } from '../../../drizzle/db';
import type { ChannelService } from '../../../channels/services/channel.service';
import type { AnalyticsEventEmitter } from '../../../realtime/analytics-event-emitter.service';
import type { PlatformInboxAdapter } from '../../adapters/inbox-adapter.interface';
import type { InboxService } from '../../inbox.service';
import type { InboxDispatcher } from '../../services/inbox-dispatcher.service';
import {
  describeInboxDb,
  seedChannel,
  seedItem,
  seedWorkspace,
  withInboxDb,
} from '../../testing/inbox-db';
import { CommentActionsService } from './comment-actions.service';
import type { ConversationResyncService } from './conversation-resync.service';
import type { ConversationSyncService } from './conversation-sync.service';
import type { InboxRealtimeService } from './inbox-realtime.service';

const asType = <T>(impl: object): T => impl as unknown as T;

interface Hooks {
  /** Runs inside the platform call, like a poll or a teammate landing mid-request. */
  midCall?: () => Promise<void>;
}

function build(db: DbType, hooks: Hooks = {}) {
  const adapter = {
    likeComment: jest.fn(async () => {
      await hooks.midCall?.();
      return { likeRef: null };
    }),
    deleteComment: jest.fn(async () => {
      await hooks.midCall?.();
      return true;
    }),
    moderateDelete: jest.fn(async () => {
      await hooks.midCall?.();
    }),
    sendPrivateReply: jest.fn(() =>
      Promise.resolve({
        recipientPlatformId: 'psid-1',
        platformItemId: 'mid-1',
        platformCreatedAt: new Date(),
      }),
    ),
  };
  const service = new CommentActionsService(
    db,
    asType<ChannelService>({
      getAccessToken: jest.fn().mockResolvedValue('t'),
    }),
    asType<InboxDispatcher>({
      get: () => asType<PlatformInboxAdapter>(adapter),
    }),
    asType<InboxService>({ upsertDm: jest.fn().mockResolvedValue(null) }),
    asType<ConversationSyncService>({
      syncThread: jest.fn().mockResolvedValue({ conversationId: null }),
    }),
    asType<ConversationResyncService>({ enqueue: jest.fn() }),
    asType<InboxRealtimeService>({ timelineAppended: jest.fn() }),
    asType<AnalyticsEventEmitter>({ emit: jest.fn() }),
  );
  return { service, adapter };
}

async function seed(
  client: PoolClient,
  metadata: Record<string, unknown>,
  over: { fromMe?: boolean } = {},
) {
  const { workspaceId } = await seedWorkspace(client);
  const channelId = await seedChannel(client, workspaceId, 'facebook');
  const item = await seedItem(client, {
    workspaceId,
    channelId,
    platform: 'facebook',
    type: 'comment',
    platformPostId: 'post-1',
    platformCreatedAt: new Date(Date.now() - 3_600_000),
    metadata,
    ...over,
  });
  return { workspaceId, channelId, itemId: item.id };
}

async function metaOf(
  client: PoolClient,
  itemId: string,
): Promise<Record<string, unknown>> {
  const r = await client.query<{ metadata: Record<string, unknown> }>(
    'SELECT metadata FROM inbox_items WHERE id = $1',
    [itemId],
  );
  return r.rows[0].metadata;
}

describeInboxDb('CommentActionsService metadata writes (real SQL)', () => {
  it('like adds 1 to the stored count and keeps unrelated keys', async () => {
    await withInboxDb(async (db, client) => {
      const s = await seed(client, { likeCount: 4, keep: 'me' });
      const { service } = build(db);
      await service.like(s.workspaceId, s.itemId, 'u', true);
      expect(await metaOf(client, s.itemId)).toMatchObject({
        likeCount: 5,
        likedByUs: true,
        keep: 'me',
      });
    });
  });

  it('unlike floors at 0 (greatest)', async () => {
    await withInboxDb(async (db, client) => {
      const s = await seed(client, { likeCount: 0, likedByUs: true });
      const { service } = build(db);
      await service.like(s.workspaceId, s.itemId, 'u', false);
      expect(await metaOf(client, s.itemId)).toMatchObject({
        likeCount: 0,
        likedByUs: false,
      });
    });
  });

  it('a poll that lands during the platform call is not overwritten', async () => {
    await withInboxDb(async (db, client) => {
      const s = await seed(client, { likeCount: 4 });
      const { service } = build(db, {
        midCall: async () => {
          await client.query(
            `UPDATE inbox_items SET metadata = metadata || '{"likeCount": 10, "polled": true}'::jsonb WHERE id = $1`,
            [s.itemId],
          );
        },
      });
      await service.like(s.workspaceId, s.itemId, 'u', true);
      expect(await metaOf(client, s.itemId)).toMatchObject({
        likeCount: 11,
        polled: true,
        likedByUs: true,
      });
    });
  });

  it('delete keeps a key another action wrote during the platform call', async () => {
    await withInboxDb(async (db, client) => {
      const s = await seed(client, { a: 1 }, { fromMe: true });
      const { service } = build(db, {
        midCall: async () => {
          await client.query(
            `UPDATE inbox_items SET metadata = metadata || '{"privateReplySentAt": "2026-01-01T00:00:00.000Z"}'::jsonb WHERE id = $1`,
            [s.itemId],
          );
        },
      });
      await service.delete(s.workspaceId, s.itemId, 'u');
      const meta = await metaOf(client, s.itemId);
      expect(meta).toMatchObject({
        a: 1,
        privateReplySentAt: '2026-01-01T00:00:00.000Z',
        deletedByUserId: 'u',
      });
      expect(meta.deletedAt).toEqual(expect.any(String));
    });
  });

  it('private reply records privateReplySentAt, so the comment no longer offers it', async () => {
    await withInboxDb(async (db, client) => {
      const s = await seed(client, { x: 1 });
      const { service } = build(db);
      await service.privateReply(s.workspaceId, s.itemId, 'u', 'hi');
      expect((await metaOf(client, s.itemId)).privateReplySentAt).toEqual(
        expect.any(String),
      );
      const err: unknown = await service
        .privateReply(s.workspaceId, s.itemId, 'u', 'again')
        .catch((e: unknown) => e);
      expect((err as { getResponse(): unknown }).getResponse()).toHaveProperty(
        'reason',
      );
    });
  });
});
