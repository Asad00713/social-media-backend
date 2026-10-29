// InboxService writes through the module-level `db`. Point that at the
// rollback harness connection for the duration of each test.
const mockHolder: { db: any } = { db: null };
jest.mock('../drizzle/db', () => ({
  db: new Proxy(
    {},
    {
      get: (_t, prop) => mockHolder.db[prop as string],
    },
  ),
}));

import type { PoolClient } from 'pg';
import type { DbType } from '../drizzle/db';
import {
  describeInboxDb,
  seedChannel,
  seedItem,
  seedWorkspace,
  withInboxDb,
} from './testing/inbox-db';
import { InboxService } from './inbox.service';
import { ConversationSyncService } from './conversations/services/conversation-sync.service';

const T0 = new Date('2026-10-26T10:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function build(db: DbType) {
  mockHolder.db = db;
  const rt = {
    conversationChanged: jest.fn(),
    conversationRemoved: jest.fn(),
    countsChanged: jest.fn(),
    timelineAppended: jest.fn(),
  };
  const sync = new ConversationSyncService(db, rt as never);
  const resync = { enqueue: jest.fn(), syncOrEnqueue: jest.fn() };
  const service = new InboxService(
    { emit: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    rt as never,
    sync,
    resync as never,
  );
  return { service, sync, resync, rt };
}

async function repliedAt(client: PoolClient, id: string): Promise<Date | null> {
  const r = await client.query<{ replied_at: Date | null }>(
    `SELECT replied_at FROM inbox_items WHERE id = $1`,
    [id],
  );
  return r.rows[0].replied_at;
}

describeInboxDb(
  'InboxService ingest: R5 predicates (platform-side replies)',
  () => {
    it('a native DM reply answers only earlier, unanswered inbound rows of its own workspace thread', () =>
      withInboxDb(async (db, client) => {
        const { workspaceId, ownerId } = await seedWorkspace(client);
        const other = await seedWorkspace(client);
        const ch = await seedChannel(client, workspaceId, 'instagram');
        const base = {
          workspaceId,
          channelId: ch,
          platform: 'instagram',
          type: 'dm' as const,
          conversationId: 'thr',
        };
        const m1 = await seedItem(client, {
          ...base,
          text: 'm1',
          platformCreatedAt: at(1),
        });
        const m3 = await seedItem(client, {
          ...base,
          text: 'm3 (sent after our reply)',
          platformCreatedAt: at(3),
        });
        const alreadyAnswered = await seedItem(client, {
          ...base,
          text: 'm0',
          repliedAt: at(0.5),
          platformCreatedAt: at(0),
        });
        const ourEarlier = await seedItem(client, {
          ...base,
          fromMe: true,
          authoredByUserId: ownerId,
          text: 'earlier outbound',
          platformCreatedAt: at(0.2),
        });
        // Same workspace and channel, another thread.
        const otherThread = await seedItem(client, {
          ...base,
          conversationId: 'thr-other',
          text: 'other thread',
          platformCreatedAt: at(1),
        });
        // Same thread key, different workspace.
        const foreign = await seedItem(client, {
          ...base,
          workspaceId: other.workspaceId,
          text: 'foreign',
          platformCreatedAt: at(1),
        });

        const { service } = build(db);
        await service.upsertDm({
          workspaceId,
          channelId: ch,
          platform: 'instagram',
          conversationId: 'thr',
          platformItemId: 'native-reply',
          text: 'answered on the Instagram app',
          fromMe: true,
          platformCreatedAt: at(2),
        });

        expect(await repliedAt(client, m1.id)).toEqual(at(2));
        expect(await repliedAt(client, m3.id)).toBeNull();
        expect(await repliedAt(client, alreadyAnswered.id)).toEqual(at(0.5));
        expect(await repliedAt(client, ourEarlier.id)).toBeNull();
        expect(await repliedAt(client, foreign.id)).toBeNull();
        expect(await repliedAt(client, otherThread.id)).toBeNull();
      }));

    it('a native comment reply answers only its parent comment in its own channel', () =>
      withInboxDb(async (db, client) => {
        const { workspaceId } = await seedWorkspace(client);
        const ch = await seedChannel(client, workspaceId, 'facebook');
        const otherCh = await seedChannel(client, workspaceId, 'facebook');
        const base = {
          workspaceId,
          platform: 'facebook',
          type: 'comment' as const,
          platformPostId: 'p1',
        };
        const parent = await seedItem(client, {
          ...base,
          channelId: ch,
          platformItemId: 'c1',
          platformCreatedAt: at(1),
        });
        const sibling = await seedItem(client, {
          ...base,
          channelId: ch,
          platformItemId: 'c2',
          platformCreatedAt: at(1),
        });
        const sameIdOtherChannel = await seedItem(client, {
          ...base,
          channelId: otherCh,
          platformItemId: 'c1',
          platformCreatedAt: at(1),
        });
        const ourParent = await seedItem(client, {
          ...base,
          channelId: ch,
          platformItemId: 'o1',
          fromMe: true,
          platformCreatedAt: at(1),
        });
        const answeredParent = await seedItem(client, {
          ...base,
          channelId: ch,
          platformItemId: 'c5',
          repliedAt: at(1.5),
          platformCreatedAt: at(1),
        });
        const laterParent = await seedItem(client, {
          ...base,
          channelId: ch,
          platformItemId: 'c9',
          platformCreatedAt: at(5),
        });

        const { service } = build(db);
        await service.upsertComment({
          workspaceId,
          channelId: ch,
          platform: 'facebook',
          platformItemId: 'r1',
          platformParentId: 'c1',
          platformPostId: 'p1',
          text: 'thanks!',
          fromMe: true,
          platformCreatedAt: at(2),
        } as never);
        for (const [id, parentId] of [
          ['r3', 'o1'],
          ['r4', 'c5'],
        ]) {
          await service.upsertComment({
            workspaceId,
            channelId: ch,
            platform: 'facebook',
            platformItemId: id,
            platformParentId: parentId,
            platformPostId: 'p1',
            text: 'again',
            fromMe: true,
            platformCreatedAt: at(2),
          } as never);
        }
        // A reply whose parent is NEWER than the reply stamps nothing (the bound).
        await service.upsertComment({
          workspaceId,
          channelId: ch,
          platform: 'facebook',
          platformItemId: 'r2',
          platformParentId: 'c9',
          platformPostId: 'p1',
          text: 'odd',
          fromMe: true,
          platformCreatedAt: at(2),
        } as never);

        expect(await repliedAt(client, parent.id)).toEqual(at(2));
        expect(await repliedAt(client, sibling.id)).toBeNull();
        expect(await repliedAt(client, sameIdOtherChannel.id)).toBeNull();
        expect(await repliedAt(client, laterParent.id)).toBeNull();
        expect(await repliedAt(client, ourParent.id)).toBeNull();
        expect(await repliedAt(client, answeredParent.id)).toEqual(at(1.5));
      }));

    it('an authored send runs no R5 (a teammate reply is stamped by the reply route)', () =>
      withInboxDb(async (db, client) => {
        const { workspaceId, ownerId } = await seedWorkspace(client);
        const ch = await seedChannel(client, workspaceId, 'instagram');
        const m1 = await seedItem(client, {
          workspaceId,
          channelId: ch,
          platform: 'instagram',
          type: 'dm',
          conversationId: 'thr',
          text: 'm1',
          platformCreatedAt: at(1),
        });
        const { service } = build(db);
        await service.upsertDm({
          workspaceId,
          channelId: ch,
          platform: 'instagram',
          conversationId: 'thr',
          platformItemId: 'sent',
          text: 'from Schedura',
          fromMe: true,
          authoredByUserId: ownerId,
          platformCreatedAt: at(2),
        });
        expect(await repliedAt(client, m1.id)).toBeNull();
      }));
  },
);

describeInboxDb('InboxService ingest: from_me flip on a merge (I2)', () => {
  const commentInput = (
    workspaceId: string,
    channelId: number,
    over: Record<string, unknown> = {},
  ) =>
    ({
      workspaceId,
      channelId,
      platform: 'facebook',
      platformItemId: 'r1',
      platformParentId: 'c1',
      platformPostId: 'p1',
      text: 'thanks!',
      platformCreatedAt: at(2),
      ...over,
    }) as never;

  it('the poll correcting the webhook echo (false -> true) stamps the parent and keeps the thread answered', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'facebook');
      const parent = await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'facebook',
        type: 'comment',
        platformItemId: 'c1',
        platformPostId: 'p1',
        platformCreatedAt: at(1),
      });
      const { service } = build(db);
      // Webhook: the Page's own comment arrives as an ordinary inbound.
      await service.upsertComment(
        commentInput(workspaceId, ch, { fromMe: false }),
      );
      expect(await repliedAt(client, parent.id)).toBeNull();
      // Poll: the same comment, now known to be ours.
      await service.upsertComment(
        commentInput(workspaceId, ch, { fromMe: true }),
      );
      expect(await repliedAt(client, parent.id)).toEqual(at(2));
      const conv = await client.query<{ status: string; unread_count: number }>(
        `SELECT status, unread_count FROM inbox_conversations
          WHERE workspace_id = $1 AND thread_key = $2`,
        [workspaceId, `${ch}:p1`],
      );
      expect(conv.rows[0].status).not.toBe('to_reply');
    }));

  it('an authored send merging onto its echo gains its author; an existing author is never wiped', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'facebook');
      const { service } = build(db);
      const authorOf = async () =>
        (
          await client.query<{ authored_by_user_id: string | null }>(
            `SELECT authored_by_user_id FROM inbox_items
              WHERE channel_id = $1 AND platform_item_id = 'r1'`,
            [ch],
          )
        ).rows[0].authored_by_user_id;

      await service.upsertComment(
        commentInput(workspaceId, ch, { fromMe: true }),
      );
      expect(await authorOf()).toBeNull();
      await service.upsertComment(
        commentInput(workspaceId, ch, {
          fromMe: true,
          authoredByUserId: ownerId,
        }),
      );
      expect(await authorOf()).toBe(ownerId);
      await service.upsertComment(
        commentInput(workspaceId, ch, { fromMe: true }),
      );
      expect(await authorOf()).toBe(ownerId);
    }));
});

describeInboxDb('InboxService ingest: mention becomes a comment (R3)', () => {
  it('moves only our replies to that mention onto the post and re-keys the conversation', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'threads');
      const otherCh = await seedChannel(client, workspaceId, 'threads');
      const mention = await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'threads',
        type: 'mention',
        platformItemId: 'm7',
        platformCreatedAt: at(1),
      });
      const ourReply = await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'threads',
        type: 'comment',
        platformItemId: 'r1',
        fromMe: true,
        metadata: { mentionRoot: 'm7' },
        platformCreatedAt: at(2),
      });
      const otherRoot = await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'threads',
        type: 'comment',
        platformItemId: 'r2',
        fromMe: true,
        metadata: { mentionRoot: 'other' },
        platformCreatedAt: at(2),
      });
      const otherChannel = await seedItem(client, {
        workspaceId,
        channelId: otherCh,
        platform: 'threads',
        type: 'comment',
        platformItemId: 'r3',
        fromMe: true,
        metadata: { mentionRoot: 'm7' },
        platformCreatedAt: at(2),
      });
      const { service, sync } = build(db);
      await sync.syncThread(workspaceId, mention.threadKey!);

      // The comment poll sees the same item under a post we know.
      await service.upsertComment({
        workspaceId,
        channelId: ch,
        platform: 'threads',
        platformItemId: 'm7',
        platformPostId: 'p9',
        text: 'nice',
        platformCreatedAt: at(1),
      } as never);

      const postOf = async (id: string) =>
        (
          await client.query<{ platform_post_id: string | null }>(
            `SELECT platform_post_id FROM inbox_items WHERE id = $1`,
            [id],
          )
        ).rows[0].platform_post_id;
      expect(await postOf(ourReply.id)).toBe('p9');
      expect(await postOf(otherRoot.id)).toBeNull();
      expect(await postOf(otherChannel.id)).toBeNull();

      const keys = await client.query<{ thread_key: string }>(
        `SELECT thread_key FROM inbox_conversations
          WHERE workspace_id = $1 AND channel_id = $2`,
        [workspaceId, ch],
      );
      expect(keys.rows.map((r) => r.thread_key)).toEqual([`${ch}:p9`]);
    }));
});

describeInboxDb('InboxService ingest: Slack start-DM authorship (I4)', () => {
  it('a teammate-authored first message is not a platform reply: the new DM is not done via platform', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const authoredCh = await seedChannel(client, workspaceId, 'slack');
      const nativeCh = await seedChannel(client, workspaceId, 'slack');
      const { service } = build(db);
      const start = (channelId: number, authored: string | null) =>
        service.upsertDm({
          workspaceId,
          channelId,
          platform: 'slack',
          conversationId: 'D1',
          platformItemId: '1700000000.0001',
          text: 'hello there',
          fromMe: true,
          authoredByUserId: authored,
          platformCreatedAt: at(1),
        });
      await start(authoredCh, ownerId);
      await start(nativeCh, null);

      const read = async (channelId: number) =>
        (
          await client.query<{ status: string; done_via: string | null }>(
            `SELECT status, done_via FROM inbox_conversations
              WHERE workspace_id = $1 AND thread_key = $2`,
            [workspaceId, `${channelId}:D1`],
          )
        ).rows[0];
      expect(await read(authoredCh)).toMatchObject({
        status: 'done',
        done_via: 'reply',
      });
      // Contrast: the same row without an author IS treated as answered on the platform.
      expect((await read(nativeCh)).done_via).toBe('platform');
      const owner = await client.query<{ done_by_user_id: string | null }>(
        `SELECT done_by_user_id FROM inbox_conversations
          WHERE workspace_id = $1 AND thread_key = $2`,
        [workspaceId, `${authoredCh}:D1`],
      );
      expect(owner.rows[0].done_by_user_id).toBe(ownerId);
    }));
});

describeInboxDb('InboxService ingest: our own DM echo lands before the authored row (N1)', () => {
  it('the authored merge resyncs and the new thread ends Done via reply, not via platform', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const { service } = build(db);
      const send = (authored: string | null) =>
        service.upsertDm({
          workspaceId,
          channelId: ch,
          platform: 'instagram',
          conversationId: 'new-contact',
          platformItemId: 'mid-1',
          text: 'hello there',
          fromMe: true,
          authoredByUserId: authored,
          platformCreatedAt: at(1),
        });
      await send(null); // the webhook echo, author-less
      const read = async () =>
        (
          await client.query<{
            status: string;
            done_via: string | null;
            done_by_user_id: string | null;
          }>(
            `SELECT status, done_via, done_by_user_id FROM inbox_conversations
              WHERE workspace_id = $1 AND thread_key = $2`,
            [workspaceId, `${ch}:new-contact`],
          )
        ).rows[0];
      expect((await read()).done_via).toBe('platform');

      await send(ownerId); // sendDm's upsert merges the author

      expect(await read()).toMatchObject({
        status: 'done',
        done_via: 'reply',
        done_by_user_id: ownerId,
      });
    }));
});
