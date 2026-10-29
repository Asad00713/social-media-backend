import { NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  describeInboxDb,
  seedChannel,
  seedItem,
  seedWorkspace,
  withInboxDb,
} from '../../testing/inbox-db';
import { loadReplyContext } from './reply-context';

const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);
const at = (n: number) => new Date(BASE + n * 60_000);

async function seedConversation(
  client: PoolClient,
  p: {
    workspaceId: string;
    channelId: number;
    platform: string;
    kind: 'dm' | 'comment_thread' | 'mention';
    threadKey: string;
  },
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO inbox_conversations
       (workspace_id, channel_id, platform, kind, thread_key, last_message_at)
     VALUES ($1,$2,$3,$4,$5, now()) RETURNING id`,
    [p.workspaceId, p.channelId, p.platform, p.kind, p.threadKey],
  );
  return r.rows[0].id;
}

describeInboxDb('loadReplyContext', () => {
  it('dm: last 10 items oldest first, me/customer mapped, empty text skipped', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const channelId = await seedChannel(client, workspaceId, 'instagram');
      for (let i = 0; i < 14; i++) {
        await seedItem(client, {
          workspaceId,
          channelId,
          platform: 'instagram',
          type: 'dm',
          conversationId: 'c1',
          fromMe: i % 2 === 1,
          text: `m${i}`,
          platformCreatedAt: at(i),
        });
      }
      await seedItem(client, {
        workspaceId,
        channelId,
        platform: 'instagram',
        type: 'dm',
        conversationId: 'c1',
        text: '   ',
        platformCreatedAt: at(20),
      });
      const convId = await seedConversation(client, {
        workspaceId,
        channelId,
        platform: 'instagram',
        kind: 'dm',
        threadKey: `${channelId}:c1`,
      });
      const ctx = await loadReplyContext(db, workspaceId, convId);
      expect(ctx.platform).toBe('instagram');
      expect(ctx.messages.map((m) => m.text)).toEqual(
        Array.from({ length: 10 }, (_, k) => `m${k + 4}`),
      );
      expect(ctx.messages[0].author).toBe('customer'); // m4
      expect(ctx.messages[1].author).toBe('me'); // m5
    }));

  it('skips redacted youtube rows (null text)', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const channelId = await seedChannel(client, workspaceId, 'youtube');
      for (const [n, text] of [
        [1, null],
        [2, 'visible'],
      ] as const) {
        await seedItem(client, {
          workspaceId,
          channelId,
          platform: 'youtube',
          type: 'comment',
          platformPostId: 'v1',
          text,
          platformCreatedAt: at(n),
        });
      }
      const convId = await seedConversation(client, {
        workspaceId,
        channelId,
        platform: 'youtube',
        kind: 'comment_thread',
        threadKey: `${channelId}:v1`,
      });
      const ctx = await loadReplyContext(db, workspaceId, convId);
      expect(ctx.messages.map((m) => m.text)).toEqual(['visible']);
    }));

  it('comment_thread: a commentId yields only its branch; without, the last 10 comments', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const channelId = await seedChannel(client, workspaceId, 'facebook');
      const mk = (
        id: string,
        parent: string | null,
        n: number,
        fromMe = false,
      ) =>
        seedItem(client, {
          workspaceId,
          channelId,
          platform: 'facebook',
          type: 'comment',
          platformPostId: 'p1',
          platformItemId: id,
          platformParentId: parent,
          fromMe,
          text: id,
          platformCreatedAt: at(n),
        });
      const rootA = await mk('A', null, 1);
      await mk('A1', 'A', 2, true);
      const a2 = await mk('A2', 'A1', 3);
      await mk('B', null, 4);
      await mk('B1', 'B', 5);
      const convId = await seedConversation(client, {
        workspaceId,
        channelId,
        platform: 'facebook',
        kind: 'comment_thread',
        threadKey: `${channelId}:p1`,
      });
      const fromReply = await loadReplyContext(db, workspaceId, convId, a2.id);
      expect(fromReply.messages.map((m) => m.text)).toEqual(['A', 'A1', 'A2']);
      expect(fromReply.messages[1].author).toBe('me');
      const fromRoot = await loadReplyContext(
        db,
        workspaceId,
        convId,
        rootA.id,
      );
      expect(fromRoot.messages.map((m) => m.text)).toEqual(['A', 'A1', 'A2']);
      const all = await loadReplyContext(db, workspaceId, convId);
      expect(all.messages.map((m) => m.text)).toEqual([
        'A',
        'A1',
        'A2',
        'B',
        'B1',
      ]);
    }));

  it('404 for a conversation in another workspace holding the same thread_key', () =>
    withInboxDb(async (db, client) => {
      const a = await seedWorkspace(client);
      const b = await seedWorkspace(client);
      const chA = await seedChannel(client, a.workspaceId, 'instagram');
      const chB = await seedChannel(client, b.workspaceId, 'instagram');
      const key = 'shared:thread';
      const convA = await seedConversation(client, {
        workspaceId: a.workspaceId,
        channelId: chA,
        platform: 'instagram',
        kind: 'dm',
        threadKey: key,
      });
      await seedConversation(client, {
        workspaceId: b.workspaceId,
        channelId: chB,
        platform: 'instagram',
        kind: 'dm',
        threadKey: key,
      });
      await expect(
        loadReplyContext(db, b.workspaceId, convA),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        loadReplyContext(
          db,
          a.workspaceId,
          '00000000-0000-4000-8000-000000000000',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    }));
});
