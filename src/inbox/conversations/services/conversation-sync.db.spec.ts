import { sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import type { DbType } from '../../../drizzle/db';
import {
  describeInboxDb,
  seedChannel,
  seedItem,
  seedMember,
  seedWorkspace,
  withInboxDb,
} from '../../testing/inbox-db';
import { ConversationSyncService } from './conversation-sync.service';

const T0 = new Date('2026-10-26T10:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

interface Fakes {
  conversationChanged: jest.Mock;
  conversationRemoved: jest.Mock;
  countsChanged: jest.Mock;
  timelineAppended: jest.Mock;
}

function build(db: DbType): { service: ConversationSyncService; rt: Fakes } {
  const rt: Fakes = {
    conversationChanged: jest.fn(),
    conversationRemoved: jest.fn(),
    countsChanged: jest.fn(),
    timelineAppended: jest.fn(),
  };
  return { service: new ConversationSyncService(db, rt as never), rt };
}

interface ConvRow {
  id: string;
  channel_id: number;
  last_message_at: Date;
  reply_window_closes_at: Date | null;
  archived_at: Date | null;
  search_text: string;
  [column: string]: unknown;
}

async function conv(
  client: PoolClient,
  workspaceId: string,
  threadKey: string,
): Promise<ConvRow | undefined> {
  const r = await client.query<ConvRow>(
    `SELECT * FROM inbox_conversations WHERE workspace_id = $1 AND thread_key = $2`,
    [workspaceId, threadKey],
  );
  return r.rows[0];
}

const queryText = (call: unknown[]): string => {
  const first = call[0];
  return typeof first === 'string'
    ? first
    : String((first as { text?: string }).text ?? '');
};

describeInboxDb('ConversationSyncService.syncThread', () => {
  it('turns one inbound IG dm into a to_reply conversation', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const item = await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'instagram',
        type: 'dm',
        conversationId: 'thr1',
        text: 'hello there',
        authorHandle: 'maya',
        authorDisplayName: 'Maya K',
        authorPlatformId: 'ig-77',
        platformCreatedAt: T0,
      });
      await client.query(
        `UPDATE inbox_items SET author_avatar_url = 'https://a/maya.png' WHERE id = $1`,
        [item.id],
      );
      const { service } = build(db);
      const res = await service.syncThread(workspaceId, item.threadKey!);

      expect(res).toMatchObject({
        created: true,
        removed: false,
        status: 'to_reply',
      });
      const c = (await conv(client, workspaceId, item.threadKey!))!;
      expect(c).toMatchObject({
        id: res.conversationId,
        kind: 'dm',
        platform: 'instagram',
        status: 'to_reply',
        unread_count: 1,
        item_count: 1,
        last_snippet: 'hello there',
        last_author_label: 'Maya K',
        last_from_me: false,
        participant_handle: 'maya',
        participant_name: 'Maya K',
        participant_avatar_url: 'https://a/maya.png',
        participant_platform_id: 'ig-77',
        title: 'Maya K',
        archived_at: null,
      });
      expect(c.channel_id).toBe(ch);
      expect(c.last_message_at.getTime()).toBe(T0.getTime());
      expect(c.reply_window_closes_at!.getTime()).toBe(
        T0.getTime() + 24 * 3600_000,
      );
      expect(c.search_text).toBe('maya k maya k maya hello there');
    }));

  it('folds 400 inbound comments on one post into one conversation', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      await client.query(
        `INSERT INTO inbox_items
           (workspace_id, channel_id, platform, type, platform_item_id,
            platform_post_id, status, text, author_handle, platform_created_at,
            metadata)
         SELECT $1, $2, 'instagram', 'comment', 'c-' || g, 'p1', 'unread',
                'hi ' || g, 'u' || g, $3::timestamptz + (g || ' seconds')::interval,
                $4::jsonb
           FROM generate_series(1, 400) g`,
        [
          workspaceId,
          ch,
          T0,
          JSON.stringify({
            post: { caption: 'Launch day', thumbnailUrl: 'https://t/1.png' },
          }),
        ],
      );
      const { service } = build(db);
      await service.syncThread(workspaceId, `${ch}:p1`);
      const all = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM inbox_conversations WHERE workspace_id = $1`,
        [workspaceId],
      );
      expect(all.rows[0].n).toBe(1);
      const c = (await conv(client, workspaceId, `${ch}:p1`))!;
      expect(c).toMatchObject({
        kind: 'comment_thread',
        unread_count: 400,
        item_count: 400,
        title: 'Launch day',
        thumbnail_url: 'https://t/1.png',
        participant_handle: null,
        participant_name: null,
        reply_window_closes_at: null,
        last_snippet: 'hi 400',
      });
    }));

  it('keeps the caption as title when the latest row is our reply without a snapshot (D2)', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'instagram',
        type: 'comment',
        platformPostId: 'p1',
        text: 'first',
        authorHandle: 'zed',
        platformCreatedAt: T0,
        metadata: {
          post: { caption: 'Launch day', thumbnailUrl: 'https://t/1.png' },
        },
      });
      await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'instagram',
        type: 'comment',
        platformPostId: 'p1',
        fromMe: true,
        authoredByUserId: ownerId,
        text: 'thanks!',
        platformCreatedAt: at(5),
      });
      const { service } = build(db);
      await service.syncThread(workspaceId, `${ch}:p1`);
      const c = (await conv(client, workspaceId, `${ch}:p1`))!;
      expect(c).toMatchObject({
        title: 'Launch day',
        thumbnail_url: 'https://t/1.png',
        last_snippet: 'thanks!',
        last_from_me: true,
      });
    }));

  it('marks done on an authored reply with outbound(markDone), then reopens on a newer inbound', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const inbound = await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'instagram',
        type: 'dm',
        conversationId: 'thr1',
        text: 'help',
        authorHandle: 'maya',
        platformCreatedAt: T0,
      });
      const key = inbound.threadKey!;
      const { service } = build(db);
      await service.syncThread(workspaceId, key);

      await client.query(
        `UPDATE inbox_items SET replied_at = $2 WHERE id = $1`,
        [inbound.id, at(1)],
      );
      await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'instagram',
        type: 'dm',
        conversationId: 'thr1',
        fromMe: true,
        authoredByUserId: ownerId,
        text: 'on it',
        platformCreatedAt: at(1),
      });
      const done = await service.syncThread(workspaceId, key, {
        kind: 'outbound',
        userId: ownerId,
        markDone: true,
        at: at(1),
      });
      expect(done).toMatchObject({ markedDone: true, status: 'done' });
      expect(await conv(client, workspaceId, key)).toMatchObject({
        status: 'done',
        done_via: 'reply',
        done_by_user_id: ownerId,
      });

      await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'instagram',
        type: 'dm',
        conversationId: 'thr1',
        text: 'thanks, one more thing',
        authorHandle: 'maya',
        platformCreatedAt: at(60),
      });
      const reopened = await service.syncThread(workspaceId, key);
      expect(reopened).toMatchObject({ reopened: true, status: 'to_reply' });
      expect(await conv(client, workspaceId, key)).toMatchObject({
        status: 'to_reply',
        done_via: null,
        done_by_user_id: null,
        unread_count: 2,
      });
    }));

  it('a hidden unanswered comment does not keep the thread open after the others are answered', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'threads');
      const base = {
        workspaceId,
        channelId: ch,
        platform: 'threads',
        type: 'comment' as const,
        platformPostId: 'p1',
      };
      await seedItem(client, {
        ...base,
        text: 'answered',
        authorHandle: 'a',
        repliedAt: at(2),
        platformCreatedAt: T0,
      });
      const hidden = await seedItem(client, {
        ...base,
        text: 'spam',
        authorHandle: 'b',
        platformCreatedAt: at(1),
      });
      await client.query(
        `UPDATE inbox_items SET is_hidden = true WHERE id = $1`,
        [hidden.id],
      );
      await seedItem(client, {
        ...base,
        fromMe: true,
        text: 'platform-side reply',
        platformCreatedAt: at(2),
      });
      const { service } = build(db);
      const res = await service.syncThread(workspaceId, `${ch}:p1`);
      expect(res.status).toBe('done');
      expect(await conv(client, workspaceId, `${ch}:p1`)).toMatchObject({
        status: 'done',
        done_via: 'platform',
      });
    }));

  it('sets archived_at when every item is archived and clears it on a new unarchived inbound', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const archivedAt = at(30);
      const a = await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'instagram',
        type: 'dm',
        conversationId: 'thr1',
        text: 'a',
        platformCreatedAt: T0,
        archivedAt,
      });
      const key = a.threadKey!;
      const { service, rt } = build(db);
      const res = await service.syncThread(workspaceId, key);
      const c = (await conv(client, workspaceId, key))!;
      expect(c.archived_at!.getTime()).toBe(archivedAt.getTime());
      expect(rt.conversationChanged).toHaveBeenCalledWith(
        workspaceId,
        res.conversationId,
      );

      await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'instagram',
        type: 'dm',
        conversationId: 'thr1',
        text: 'b',
        platformCreatedAt: at(40),
      });
      await service.syncThread(workspaceId, key);
      expect((await conv(client, workspaceId, key))!.archived_at).toBeNull();
    }));

  it('deletes the conversation once no item is left and announces the removal', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const a = await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'instagram',
        type: 'dm',
        conversationId: 'thr1',
        text: 'a',
        platformCreatedAt: T0,
      });
      const key = a.threadKey!;
      const { service, rt } = build(db);
      const created = await service.syncThread(workspaceId, key);
      await client.query(`DELETE FROM inbox_items WHERE id = $1`, [a.id]);
      rt.countsChanged.mockClear();

      const res = await service.syncThread(workspaceId, key);
      expect(res).toMatchObject({
        removed: true,
        conversationId: created.conversationId,
      });
      expect(await conv(client, workspaceId, key)).toBeUndefined();
      expect(rt.conversationRemoved).toHaveBeenCalledWith(
        workspaceId,
        created.conversationId,
      );
      expect(rt.countsChanged).toHaveBeenCalledWith(workspaceId);
    }));

  it('is a no-op the second time (all columns but updated_at)', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const a = await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'instagram',
        type: 'dm',
        conversationId: 'thr1',
        text: 'a',
        authorHandle: 'maya',
        platformCreatedAt: T0,
      });
      const key = a.threadKey!;
      const { service } = build(db);
      await service.syncThread(workspaceId, key);
      const first = { ...(await conv(client, workspaceId, key))! };
      const second = await service.syncThread(workspaceId, key);
      const after = { ...(await conv(client, workspaceId, key))! };
      delete first.updated_at;
      delete after.updated_at;
      expect(after).toEqual(first);
      expect(second.created).toBe(false);
    }));

  it('takes the thread advisory lock as the first statement of its transaction', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const a = await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'instagram',
        type: 'dm',
        conversationId: 'thr1',
        text: 'a',
        platformCreatedAt: T0,
      });
      const { service } = build(db);
      const spy = jest.spyOn(client, 'query');
      await service.syncThread(workspaceId, a.threadKey!);
      const texts = spy.mock.calls.map((c) => queryText(c).toLowerCase());
      const sp = texts.findIndex((t) => t.includes('savepoint'));
      expect(sp).toBeGreaterThanOrEqual(0);
      expect(texts[sp + 1]).toContain('pg_advisory_xact_lock');
      spy.mockRestore();
    }));

  it('rolls back its own writes when a statement fails mid-transaction', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const a = await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'instagram',
        type: 'dm',
        conversationId: 'thr1',
        text: 'a',
        platformCreatedAt: T0,
      });
      const key = a.threadKey!;
      const { service } = build(db);
      await service.syncThread(workspaceId, key);
      const before = { ...(await conv(client, workspaceId, key))! };

      await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'instagram',
        type: 'dm',
        conversationId: 'thr1',
        text: 'newer',
        platformCreatedAt: at(5),
      });
      const real = client.query.bind(client) as (...a: unknown[]) => unknown;
      const spy = jest.spyOn(client, 'query').mockImplementation(((
        ...args: unknown[]
      ) => {
        if (queryText(args).includes('INSERT INTO inbox_conversations')) {
          return Promise.reject(new Error('boom'));
        }
        return real(...args);
      }) as never);
      // drizzle wraps the driver error as the cause of a "Failed query".
      await expect(service.syncThread(workspaceId, key)).rejects.toMatchObject({
        cause: { message: 'boom' },
      });
      spy.mockRestore();
      expect(await conv(client, workspaceId, key)).toEqual(before);
    }));
});

describeInboxDb('ConversationSyncService.rekey', () => {
  it('moves notes and pending scheduled replies to the target and drops the emptied conversation', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const mate = await seedMember(client, workspaceId, 'MEMBER');
      const ch = await seedChannel(client, workspaceId, 'threads');
      const fromKey = `${ch}:mention:m7`;
      const toKey = `${ch}:p9`;

      const mention = await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'threads',
        type: 'mention',
        platformItemId: 'm7',
        text: 'hey @us',
        authorHandle: 'zed',
        platformCreatedAt: at(10),
      });
      expect(mention.threadKey).toBe(fromKey);
      // An existing conversation for the target, with its own triage state.
      await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'threads',
        type: 'comment',
        platformPostId: 'p9',
        text: 'older comment',
        authorHandle: 'amy',
        platformCreatedAt: T0,
      });
      const { service } = build(db);
      const from = await service.syncThread(workspaceId, fromKey);
      const to = await service.syncThread(workspaceId, toKey);
      await client.query(
        `UPDATE inbox_conversations
            SET status = 'later', later_until = $2, assignee_user_id = $3
          WHERE id = $1`,
        [to.conversationId, at(60 * 24 * 30), mate],
      );
      await client.query(
        `INSERT INTO inbox_notes (conversation_id, workspace_id, author_user_id, body)
         VALUES ($1, $2, $3, 'context')`,
        [from.conversationId, workspaceId, ownerId],
      );
      await client.query(
        `INSERT INTO scheduled_inbox_messages
           (workspace_id, channel_id, type, thread_key, text, scheduled_at,
            status, inbox_conversation_id, created_by_user_id)
         VALUES ($1, $2, 'comment', $3, 'later reply', $4, 'pending', $5, $6)`,
        [workspaceId, ch, fromKey, at(120), from.conversationId, ownerId],
      );

      // The mention turns out to be a comment on post p9.
      await client.query(
        `UPDATE inbox_items
            SET type = 'comment', platform_post_id = 'p9'
          WHERE id = $1`,
        [mention.id],
      );
      await service.rekey(workspaceId, fromKey, toKey);

      expect(await conv(client, workspaceId, fromKey)).toBeUndefined();
      const target = (await conv(client, workspaceId, toKey))!;
      expect(target.id).toBe(to.conversationId);
      expect(target).toMatchObject({
        status: 'later',
        assignee_user_id: mate,
        item_count: 2,
      });
      const notes = await client.query<{ conversation_id: string }>(
        `SELECT conversation_id FROM inbox_notes WHERE workspace_id = $1`,
        [workspaceId],
      );
      expect(notes.rows.map((r) => r.conversation_id)).toEqual([
        to.conversationId,
      ]);
      const sched = await client.query(
        `SELECT inbox_conversation_id, thread_key FROM scheduled_inbox_messages
          WHERE workspace_id = $1`,
        [workspaceId],
      );
      expect(sched.rows).toEqual([
        { inbox_conversation_id: to.conversationId, thread_key: toKey },
      ]);
    }));

  it('creates the target conversation when it did not exist yet', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'threads');
      const fromKey = `${ch}:mention:m7`;
      const toKey = `${ch}:p9`;
      const mention = await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'threads',
        type: 'mention',
        platformItemId: 'm7',
        text: 'hey',
        platformCreatedAt: T0,
      });
      const { service } = build(db);
      const from = await service.syncThread(workspaceId, fromKey);
      await client.query(
        `INSERT INTO inbox_notes (conversation_id, workspace_id, author_user_id, body)
         VALUES ($1, $2, $3, 'context')`,
        [from.conversationId, workspaceId, ownerId],
      );
      await client.query(
        `UPDATE inbox_items SET type = 'comment', platform_post_id = 'p9' WHERE id = $1`,
        [mention.id],
      );
      await service.rekey(workspaceId, fromKey, toKey);
      const target = (await conv(client, workspaceId, toKey))!;
      expect(target.kind).toBe('comment_thread');
      const notes = await client.query<{ conversation_id: string }>(
        `SELECT conversation_id FROM inbox_notes WHERE workspace_id = $1`,
        [workspaceId],
      );
      expect(notes.rows[0].conversation_id).toBe(target.id);
    }));
});

describeInboxDb('rollback harness (parked from Task 1)', () => {
  it('a nested error swallowed inside the harness still rolls back the outer writes', async () => {
    let workspaceId = '';
    await withInboxDb(async (db, client) => {
      ({ workspaceId } = await seedWorkspace(client));
      await client.query(`UPDATE workspace SET name = 'outer' WHERE id = $1`, [
        workspaceId,
      ]);
      await db
        .transaction(async (tx) => {
          await tx.execute(
            sql`UPDATE workspace SET name = 'inner' WHERE id = ${workspaceId}::uuid`,
          );
          throw new Error('inner failure');
        })
        .catch(() => undefined);
      const r = await client.query<{ name: string }>(
        `SELECT name FROM workspace WHERE id = $1`,
        [workspaceId],
      );
      // The savepoint rolled the inner write back; the outer write is intact...
      expect(r.rows[0].name).toBe('outer');
    });
    // ...until the harness itself rolls everything back.
    await withInboxDb(async (_db, client) => {
      const r = await client.query(`SELECT 1 FROM workspace WHERE id = $1`, [
        workspaceId,
      ]);
      expect(r.rowCount).toBe(0);
    });
  });

  it('rolls back writes made before an error thrown out of the harness', async () => {
    let workspaceId = '';
    await expect(
      withInboxDb(async (_db, client) => {
        ({ workspaceId } = await seedWorkspace(client));
        throw new Error('test body failed');
      }),
    ).rejects.toThrow('test body failed');
    await withInboxDb(async (_db, client) => {
      const r = await client.query(`SELECT 1 FROM workspace WHERE id = $1`, [
        workspaceId,
      ]);
      expect(r.rowCount).toBe(0);
    });
  });
});
