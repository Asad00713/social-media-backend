import {
  describeInboxDb,
  seedChannel,
  seedItem,
  seedWorkspace,
  withInboxDb,
} from '../testing/inbox-db';
import { deriveThreadKey } from './lib/thread-key';

const at = new Date('2026-01-01T00:00:00.000Z');

async function insertConv(
  client: import('pg').PoolClient,
  w: string,
  ch: number,
  over: Record<string, unknown> = {},
) {
  const v = {
    kind: 'dm',
    thread_key: `${ch}:k`,
    status: 'to_reply',
    later_until: null,
    later_until_reply: false,
    ...over,
  };
  return client.query(
    `INSERT INTO inbox_conversations
       (workspace_id, channel_id, platform, kind, thread_key, status,
        later_until, later_until_reply, last_message_at)
     VALUES ($1,$2,'facebook',$3,$4,$5,$6,$7,now())`,
    [w, ch, v.kind, v.thread_key, v.status, v.later_until, v.later_until_reply],
  );
}

async function expectCode(
  client: import('pg').PoolClient,
  code: string,
  fn: () => Promise<unknown>,
) {
  await client.query('SAVEPOINT s');
  await expect(fn()).rejects.toMatchObject({ code });
  await client.query('ROLLBACK TO SAVEPOINT s');
}

describeInboxDb('inbox thread_key + inbox_conversations', () => {
  it('stored thread_key matches deriveThreadKey for every shape', () =>
    withInboxDb(async (_db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const channelId = await seedChannel(client, workspaceId, 'facebook');
      const common = { workspaceId, channelId, platform: 'facebook' };
      const cases = [
        {
          type: 'dm' as const,
          platformItemId: 'd1',
          conversationId: 'pg:9',
          platformPostId: 'p-ignored',
          metadata: undefined,
        },
        {
          type: 'comment' as const,
          platformItemId: 'c1',
          conversationId: null,
          platformPostId: 'p1',
          metadata: undefined,
        },
        {
          type: 'mention' as const,
          platformItemId: 'm7',
          conversationId: null,
          platformPostId: null,
          metadata: undefined,
        },
        {
          type: 'mention' as const,
          platformItemId: 'r1',
          conversationId: null,
          platformPostId: null,
          metadata: { mentionRoot: 'm7' },
        },
      ];
      for (const c of cases) {
        const { threadKey } = await seedItem(client, {
          ...common,
          ...c,
          platformCreatedAt: at,
        });
        expect(threadKey).toBe(deriveThreadKey({ ...c, channelId }));
        expect(threadKey).not.toBeNull();
      }
    }));

  it('re-derives when type and platform_post_id change', () =>
    withInboxDb(async (_db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const channelId = await seedChannel(client, workspaceId, 'threads');
      const { id, threadKey } = await seedItem(client, {
        workspaceId,
        channelId,
        platform: 'threads',
        type: 'mention',
        platformItemId: 'm1',
        platformCreatedAt: at,
      });
      expect(threadKey).toBe(`${channelId}:mention:m1`);
      const r = await client.query<{ thread_key: string }>(
        `UPDATE inbox_items SET type='comment', platform_post_id='p9'
         WHERE id=$1 RETURNING thread_key`,
        [id],
      );
      expect(r.rows[0].thread_key).toBe(`${channelId}:p9`);
    }));

  it('enforces conversation constraints', () =>
    withInboxDb(async (_db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'facebook');
      await insertConv(client, workspaceId, ch);
      await expectCode(client, '23505', () =>
        insertConv(client, workspaceId, ch),
      );
      await expectCode(client, '23514', () =>
        insertConv(client, workspaceId, ch, {
          thread_key: 'a',
          status: 'later',
        }),
      );
      await expectCode(client, '23514', () =>
        insertConv(client, workspaceId, ch, {
          thread_key: 'b',
          kind: 'thread',
        }),
      );
      await insertConv(client, workspaceId, ch, {
        thread_key: 'c',
        status: 'later',
        later_until_reply: true,
      });
    }));

  it('has the unique index name and pg_trgm', () =>
    withInboxDb(async (_db, client) => {
      const e = await client.query(
        `SELECT 1 FROM pg_extension WHERE extname='pg_trgm'`,
      );
      expect(e.rowCount).toBe(1);
      const i = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename='inbox_conversations'`,
      );
      expect(i.rows.map((r) => r.indexname)).toEqual(
        expect.arrayContaining([
          'inbox_conversations_ws_key_uq',
          'inbox_conversations_view_idx',
          'inbox_conversations_search_trgm_idx',
        ]),
      );
    }));
});
