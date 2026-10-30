import { readFileSync } from 'fs';
import { join } from 'path';
import type { PoolClient } from 'pg';
import type { DbType } from '../../drizzle/db';
import {
  describeInboxDb,
  seedChannel,
  seedItem,
  seedMember,
  seedWorkspace,
  withInboxDb,
} from '../testing/inbox-db';
import { ConversationSyncService } from './services/conversation-sync.service';

const BACKFILL_SQL = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    '..',
    'drizzle',
    'migrations',
    '0052_inbox_conversations_backfill.sql',
  ),
  'utf8',
);

const T0 = new Date('2026-10-26T10:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

type Row = Record<string, unknown>;

async function runBackfill(client: PoolClient): Promise<void> {
  await client.query(BACKFILL_SQL);
}

async function convOf(
  client: PoolClient,
  workspaceId: string,
  threadKey: string,
): Promise<Row> {
  const r = await client.query<Row>(
    `SELECT * FROM inbox_conversations WHERE workspace_id = $1 AND thread_key = $2`,
    [workspaceId, threadKey],
  );
  expect(r.rows).toHaveLength(1);
  return r.rows[0];
}

async function allConvs(client: PoolClient, workspaceId: string) {
  const r = await client.query<Row>(
    `SELECT * FROM inbox_conversations WHERE workspace_id = $1 ORDER BY thread_key`,
    [workspaceId],
  );
  return r.rows;
}

/** Everything but the bookkeeping timestamps, which a refresh legitimately bumps. */
const stable = (row: Row): Row =>
  Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'updated_at'));

function syncOf(db: DbType): ConversationSyncService {
  const rt = {
    conversationChanged: jest.fn(),
    conversationRemoved: jest.fn(),
    countsChanged: jest.fn(),
    timelineAppended: jest.fn(),
  };
  return new ConversationSyncService(db, rt as never);
}

interface Fixtures {
  workspaceId: string;
  ownerId: string;
  author: string;
  keys: Record<string, string>;
  scheduledDirect: string;
  scheduledNested: string;
}

async function seedFixtures(client: PoolClient): Promise<Fixtures> {
  const { workspaceId, ownerId } = await seedWorkspace(client);
  const author = await seedMember(client, workspaceId, 'MEMBER');
  const ch = await seedChannel(client, workspaceId, 'instagram');
  const base = { workspaceId, channelId: ch, platform: 'instagram' };
  const keys: Record<string, string> = {};
  const keyOf = (name: string, k: string | null) => {
    keys[name] = k!;
  };

  // A: a dm with an unread inbound.
  keyOf(
    'unreadDm',
    (
      await seedItem(client, {
        ...base,
        type: 'dm',
        conversationId: 'dm-a',
        status: 'unread',
        text: 'are you open?',
        authorHandle: 'ann',
        authorDisplayName: 'Ann',
        authorPlatformId: 'ig-ann',
        platformCreatedAt: at(0),
      })
    ).threadKey,
  );

  // B: a dm answered from Schedura (authored outbound after a replied inbound).
  await seedItem(client, {
    ...base,
    type: 'dm',
    conversationId: 'dm-b',
    status: 'replied',
    text: 'price?',
    authorHandle: 'bob',
    authorDisplayName: 'Bob',
    platformCreatedAt: at(1),
  });
  keyOf(
    'answeredDm',
    (
      await seedItem(client, {
        ...base,
        type: 'dm',
        conversationId: 'dm-b',
        fromMe: true,
        authoredByUserId: author,
        status: 'replied',
        text: '10 dollars',
        platformCreatedAt: at(2),
      })
    ).threadKey,
  );

  // C: a comment thread answered natively; the inbound is still needs_reply.
  await seedItem(client, {
    ...base,
    type: 'comment',
    platformPostId: 'post-c',
    platformItemId: 'c1',
    status: 'needs_reply',
    text: 'love it',
    authorHandle: 'cy',
    platformCreatedAt: at(3),
    metadata: {
      post: { caption: 'Autumn drop', thumbnailUrl: 'https://t/c.png' },
    },
  });
  keyOf(
    'nativeComment',
    (
      await seedItem(client, {
        ...base,
        type: 'comment',
        platformPostId: 'post-c',
        platformItemId: 'c1-reply',
        platformParentId: 'c1',
        fromMe: true,
        status: 'replied',
        text: 'thanks!',
        platformCreatedAt: at(4),
      })
    ).threadKey,
  );

  // D: every inbound row already done, no outbound at all.
  keyOf(
    'manualDone',
    (
      await seedItem(client, {
        ...base,
        type: 'comment',
        platformPostId: 'post-d',
        platformItemId: 'd1',
        status: 'done',
        repliedAt: at(6),
        text: 'ok',
        authorHandle: 'dee',
        platformCreatedAt: at(5),
      })
    ).threadKey,
  );

  // E: an all-archived thread.
  await seedItem(client, {
    ...base,
    type: 'dm',
    conversationId: 'dm-e',
    status: 'done',
    text: 'old',
    platformCreatedAt: at(7),
    archivedAt: at(8),
  });
  keyOf(
    'archived',
    (
      await seedItem(client, {
        ...base,
        type: 'dm',
        conversationId: 'dm-e',
        status: 'done',
        text: 'older',
        platformCreatedAt: at(7.5),
        archivedAt: at(9),
      })
    ).threadKey,
  );

  // F: a thread a teammate started: authored outbound only (Task 8 re-review).
  keyOf(
    'teammateStarted',
    (
      await seedItem(client, {
        ...base,
        type: 'dm',
        conversationId: 'dm-f',
        fromMe: true,
        authoredByUserId: author,
        status: 'replied',
        text: 'hi, a question for you',
        platformCreatedAt: at(10),
      })
    ).threadKey,
  );

  // G: a comment thread whose latest row is our reply (no snapshot) and which
  // has a hidden newer inbound that must not count.
  await seedItem(client, {
    ...base,
    type: 'comment',
    platformPostId: 'post-g',
    platformItemId: 'g1',
    status: 'replied',
    repliedAt: at(12),
    text: 'nice',
    authorHandle: 'gus',
    authorDisplayName: 'Gus',
    platformCreatedAt: at(11),
    metadata: {
      post: { caption: 'Post G caption', thumbnailUrl: 'https://t/g.png' },
    },
  });
  await seedItem(client, {
    ...base,
    type: 'comment',
    platformPostId: 'post-g',
    platformItemId: 'g2',
    platformParentId: 'g1',
    fromMe: true,
    authoredByUserId: author,
    status: 'replied',
    text: 'thank you',
    platformCreatedAt: at(12),
  });
  keyOf(
    'hiddenInbound',
    (
      await seedItem(client, {
        ...base,
        type: 'comment',
        platformPostId: 'post-g',
        platformItemId: 'g3',
        status: 'unread',
        text: 'spam spam',
        authorHandle: 'spammer',
        platformCreatedAt: at(13),
      })
    ).threadKey,
  );
  await client.query(
    `UPDATE inbox_items SET is_hidden = true WHERE workspace_id = $1 AND platform_item_id = 'g3'`,
    [workspaceId],
  );

  // A pending scheduled reply on A, and a nested reply addressed by the parent
  // item's uuid (D20) on C's comment.
  const parent = await client.query<{ id: string }>(
    `SELECT id FROM inbox_items WHERE workspace_id = $1 AND platform_item_id = 'c1'`,
    [workspaceId],
  );
  const sched = async (threadKey: string, parentItemId: string | null) => {
    const r = await client.query<{ id: string }>(
      `INSERT INTO scheduled_inbox_messages
         (workspace_id, channel_id, type, thread_key, parent_item_id, text,
          scheduled_at, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, 'later', now() + interval '1 day', $6)
       RETURNING id`,
      [
        workspaceId,
        ch,
        parentItemId ? 'comment' : 'dm',
        threadKey,
        parentItemId,
        ownerId,
      ],
    );
    return r.rows[0].id;
  };
  const scheduledDirect = await sched(keys.unreadDm, null);
  const scheduledNested = await sched(parent.rows[0].id, parent.rows[0].id);

  return {
    workspaceId,
    ownerId,
    author,
    keys,
    scheduledDirect,
    scheduledNested,
  };
}

async function addInbound(
  client: PoolClient,
  f: Fixtures,
  conversationId: string,
  minutes: number,
): Promise<void> {
  const ch = (
    await client.query<{ channel_id: number }>(
      `SELECT channel_id FROM inbox_conversations
        WHERE workspace_id = $1 AND thread_key LIKE '%:' || $2`,
      [f.workspaceId, conversationId],
    )
  ).rows[0].channel_id;
  await seedItem(client, {
    workspaceId: f.workspaceId,
    channelId: ch,
    platform: 'instagram',
    type: 'dm',
    conversationId,
    status: 'unread',
    text: `late ${minutes}`,
    platformCreatedAt: at(minutes),
  });
}

describeInboxDb('0052 inbox conversations backfill', () => {
  it('a dm with an unread inbound lands in to_reply with unread_count 1', () =>
    withInboxDb(async (_db, client) => {
      const f = await seedFixtures(client);
      await runBackfill(client);
      const c = await convOf(client, f.workspaceId, f.keys.unreadDm);
      expect(c).toMatchObject({
        status: 'to_reply',
        unread_count: 1,
        done_via: null,
        done_by_user_id: null,
        kind: 'dm',
        participant_handle: 'ann',
        title: 'Ann',
      });
    }));

  it('a dm answered from Schedura is done via reply, by the author of the latest outbound', () =>
    withInboxDb(async (_db, client) => {
      const f = await seedFixtures(client);
      await runBackfill(client);
      const c = await convOf(client, f.workspaceId, f.keys.answeredDm);
      expect(c).toMatchObject({
        status: 'done',
        done_via: 'reply',
        done_by_user_id: f.author,
        last_from_me: true,
      });
      expect((c.done_at as Date).getTime()).toBe(at(2).getTime());
      // step 1b: the dm inbound got its answered mark.
      const inbound = await client.query<{ replied_at: Date | null }>(
        `SELECT replied_at FROM inbox_items WHERE workspace_id = $1 AND text = 'price?'`,
        [f.workspaceId],
      );
      expect(inbound.rows[0].replied_at!.getTime()).toBe(at(2).getTime());
    }));

  it('a comment answered natively gets replied_at, and per D8 (not the legacy needs_reply rule) lands done via platform', () =>
    withInboxDb(async (_db, client) => {
      const f = await seedFixtures(client);
      await runBackfill(client);
      const inbound = await client.query<{ replied_at: Date | null }>(
        `SELECT replied_at FROM inbox_items WHERE workspace_id = $1 AND platform_item_id = 'c1'`,
        [f.workspaceId],
      );
      expect(inbound.rows[0].replied_at!.getTime()).toBe(at(4).getTime());
      const c = await convOf(client, f.workspaceId, f.keys.nativeComment);
      expect(c).toMatchObject({
        status: 'done',
        done_via: 'platform',
        done_by_user_id: null,
        title: 'Autumn drop',
        thumbnail_url: 'https://t/c.png',
      });
      expect((c.done_at as Date).getTime()).toBe(at(4).getTime());
    }));

  it('a thread whose rows are all done with no outbound is done via manual at last_message_at', () =>
    withInboxDb(async (_db, client) => {
      const f = await seedFixtures(client);
      await runBackfill(client);
      const c = await convOf(client, f.workspaceId, f.keys.manualDone);
      expect(c).toMatchObject({
        status: 'done',
        done_via: 'manual',
        done_by_user_id: null,
      });
      expect((c.done_at as Date).getTime()).toBe(at(5).getTime());
    }));

  it('an all-archived thread gets archived_at', () =>
    withInboxDb(async (_db, client) => {
      const f = await seedFixtures(client);
      await runBackfill(client);
      const c = await convOf(client, f.workspaceId, f.keys.archived);
      expect((c.archived_at as Date).getTime()).toBe(at(9).getTime());
    }));

  it('a thread a teammate started (authored outbound only) lands done via reply by that author, not platform', () =>
    withInboxDb(async (_db, client) => {
      const f = await seedFixtures(client);
      await runBackfill(client);
      const c = await convOf(client, f.workspaceId, f.keys.teammateStarted);
      expect(c).toMatchObject({
        status: 'done',
        done_via: 'reply',
        done_by_user_id: f.author,
        last_inbound_at: null,
      });
      expect((c.done_at as Date).getTime()).toBe(at(10).getTime());
    }));

  it('hidden inbound rows do not count, and the title survives our own reply being the latest row', () =>
    withInboxDb(async (_db, client) => {
      const f = await seedFixtures(client);
      await runBackfill(client);
      const c = await convOf(client, f.workspaceId, f.keys.hiddenInbound);
      expect(c).toMatchObject({
        unread_count: 0,
        item_count: 3,
        title: 'Post G caption',
        thumbnail_url: 'https://t/g.png',
        last_snippet: 'thank you',
        status: 'done',
      });
      expect((c.last_inbound_at as Date).getTime()).toBe(at(11).getTime());
    }));

  it('links scheduled replies, including a nested reply addressed by its parent item uuid (D20)', () =>
    withInboxDb(async (_db, client) => {
      const f = await seedFixtures(client);
      await runBackfill(client);
      const unread = await convOf(client, f.workspaceId, f.keys.unreadDm);
      const native = await convOf(client, f.workspaceId, f.keys.nativeComment);
      const r = await client.query<{
        id: string;
        inbox_conversation_id: string;
      }>(
        `SELECT id, inbox_conversation_id FROM scheduled_inbox_messages
          WHERE workspace_id = $1`,
        [f.workspaceId],
      );
      const link = (id: string) =>
        r.rows.find((x) => x.id === id)!.inbox_conversation_id;
      expect(link(f.scheduledDirect)).toBe(unread.id);
      expect(link(f.scheduledNested)).toBe(native.id);
    }));

  it('parity: a syncThread refresh after the backfill changes nothing, for every fixture conversation', () =>
    withInboxDb(async (db, client) => {
      const f = await seedFixtures(client);
      await runBackfill(client);
      const before = (await allConvs(client, f.workspaceId)).map(stable);
      expect(before).toHaveLength(Object.keys(f.keys).length);
      const service = syncOf(db);
      for (const key of Object.values(f.keys)) {
        await service.syncThread(f.workspaceId, key);
      }
      const after = (await allConvs(client, f.workspaceId)).map(stable);
      expect(after).toEqual(before);
    }));

  describe('re-run lifecycle for newer inbound', () => {
    it('reopens a done conversation and clears done_*', () =>
      withInboxDb(async (_db, client) => {
        const f = await seedFixtures(client);
        await runBackfill(client);
        await addInbound(client, f, 'dm-b', 40);
        await runBackfill(client);
        const c = await convOf(client, f.workspaceId, f.keys.answeredDm);
        expect(c).toMatchObject({
          status: 'to_reply',
          done_via: null,
          done_by_user_id: null,
          done_at: null,
          unread_count: 1,
        });
      }));

    it('keeps a done conversation done when the added inbound is not newer', () =>
      withInboxDb(async (_db, client) => {
        const f = await seedFixtures(client);
        await runBackfill(client);
        await addInbound(client, f, 'dm-b', -5);
        await runBackfill(client);
        const c = await convOf(client, f.workspaceId, f.keys.answeredDm);
        expect(c).toMatchObject({
          status: 'done',
          done_via: 'reply',
          done_by_user_id: f.author,
        });
        expect(c.item_count).toBe(3);
      }));

    it('reopens when the stored last_inbound_at is NULL and a first inbound arrives', () =>
      withInboxDb(async (_db, client) => {
        const f = await seedFixtures(client);
        await runBackfill(client);
        await addInbound(client, f, 'dm-f', 50);
        await runBackfill(client);
        const c = await convOf(client, f.workspaceId, f.keys.teammateStarted);
        expect(c).toMatchObject({
          status: 'to_reply',
          done_via: null,
          done_by_user_id: null,
          done_at: null,
        });
      }));

    it('wakes a later conversation that waits for a reply, clearing later_*', () =>
      withInboxDb(async (_db, client) => {
        const f = await seedFixtures(client);
        await runBackfill(client);
        await client.query(
          `UPDATE inbox_conversations
              SET status = 'later', later_until = NULL, later_until_reply = true
            WHERE workspace_id = $1 AND thread_key = $2`,
          [f.workspaceId, f.keys.unreadDm],
        );
        await addInbound(client, f, 'dm-a', 60);
        await runBackfill(client);
        const c = await convOf(client, f.workspaceId, f.keys.unreadDm);
        expect(c).toMatchObject({
          status: 'to_reply',
          later_until: null,
          later_until_reply: false,
        });
      }));

    it('does not apply the platform-reply close rule on conflict', () =>
      withInboxDb(async (_db, client) => {
        const f = await seedFixtures(client);
        await runBackfill(client);
        const ch = (await convOf(client, f.workspaceId, f.keys.unreadDm))
          .channel_id as number;
        // A native reply arrives that answers the unread dm. Only the insert
        // path applies rule 2; a re-run leaves the thread open.
        await seedItem(client, {
          workspaceId: f.workspaceId,
          channelId: ch,
          platform: 'instagram',
          type: 'dm',
          conversationId: 'dm-a',
          fromMe: true,
          status: 'replied',
          text: 'native answer',
          platformCreatedAt: at(70),
        });
        await runBackfill(client);
        const c = await convOf(client, f.workspaceId, f.keys.unreadDm);
        expect(c.status).toBe('to_reply');
      }));
  });

  it('a no-op re-run does not rewrite rows or bump updated_at', () =>
    withInboxDb(async (_db, client) => {
      const f = await seedFixtures(client);
      await runBackfill(client);
      await client.query(
        `UPDATE inbox_conversations SET updated_at = '2020-01-01T00:00:00Z'
          WHERE workspace_id = $1`,
        [f.workspaceId],
      );
      await runBackfill(client);
      const r = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM inbox_conversations
          WHERE workspace_id = $1 AND updated_at <> '2020-01-01T00:00:00Z'`,
        [f.workspaceId],
      );
      expect(Number(r.rows[0].n)).toBe(0);
      // ...but a changed thread is rewritten.
      await addInbound(client, f, 'dm-a', 80);
      await runBackfill(client);
      const c = await convOf(client, f.workspaceId, f.keys.unreadDm);
      expect(c.updated_at).not.toEqual(new Date('2020-01-01T00:00:00Z'));
    }));

  it('archived_at is truncated to milliseconds like every other timestamp', () =>
    withInboxDb(async (_db, client) => {
      const f = await seedFixtures(client);
      await client.query(
        `UPDATE inbox_items SET archived_at = '2026-10-26T10:09:00.123456Z'
          WHERE workspace_id = $1 AND conversation_id = 'dm-e'`,
        [f.workspaceId],
      );
      await runBackfill(client);
      const c = await convOf(client, f.workspaceId, f.keys.archived);
      expect((c.archived_at as Date).getTime()).toBe(
        new Date('2026-10-26T10:09:00.123Z').getTime(),
      );
      const r = await client.query<{ us: string }>(
        `SELECT extract(microseconds FROM archived_at)::text AS us
           FROM inbox_conversations WHERE workspace_id = $1 AND thread_key = $2`,
        [f.workspaceId, f.keys.archived],
      );
      expect(Number(r.rows[0].us) % 1000).toBe(0);
    }));

  it('parity: a deleted-then-recreated conversation gets the same state from syncThread as from the backfill', () =>
    withInboxDb(async (db, client) => {
      const f = await seedFixtures(client);
      await runBackfill(client);
      const service = syncOf(db);
      const bookkeeping = (row: Row): Row =>
        Object.fromEntries(
          Object.entries(row).filter(
            ([k]) => !['updated_at', 'id', 'created_at'].includes(k),
          ),
        );
      for (const name of ['unreadDm', 'nativeComment', 'teammateStarted']) {
        const key = f.keys[name];
        const before = bookkeeping(await convOf(client, f.workspaceId, key));
        await client.query(
          `DELETE FROM inbox_conversations WHERE workspace_id = $1 AND thread_key = $2`,
          [f.workspaceId, key],
        );
        await service.syncThread(f.workspaceId, key);
        const after = bookkeeping(await convOf(client, f.workspaceId, key));
        expect({ name, ...after }).toEqual({ name, ...before });
      }
    }));

  describe('re-run safety', () => {
    it('keeps triage state and refreshes derived columns', () =>
      withInboxDb(async (_db, client) => {
        const f = await seedFixtures(client);
        await runBackfill(client);
        const laterUntil = new Date('2027-01-01T00:00:00.000Z');
        await client.query(
          `UPDATE inbox_conversations
              SET status = 'later', later_until = $3, assignee_user_id = $4
            WHERE workspace_id = $1 AND thread_key = $2`,
          [f.workspaceId, f.keys.unreadDm, laterUntil, f.author],
        );
        const channelId = (
          await client.query<{ channel_id: number }>(
            `SELECT channel_id FROM inbox_conversations WHERE thread_key = $1 AND workspace_id = $2`,
            [f.keys.unreadDm, f.workspaceId],
          )
        ).rows[0].channel_id;
        await seedItem(client, {
          workspaceId: f.workspaceId,
          channelId,
          platform: 'instagram',
          type: 'dm',
          conversationId: 'dm-a',
          status: 'unread',
          text: 'hello??',
          platformCreatedAt: at(30),
        });

        await runBackfill(client);

        const c = await convOf(client, f.workspaceId, f.keys.unreadDm);
        expect(c).toMatchObject({
          status: 'later',
          assignee_user_id: f.author,
          unread_count: 2,
          item_count: 2,
          last_snippet: 'hello??',
        });
        expect((c.later_until as Date).getTime()).toBe(laterUntil.getTime());
      }));

    it('a second run with no changes leaves every row identical', () =>
      withInboxDb(async (_db, client) => {
        const f = await seedFixtures(client);
        await runBackfill(client);
        const first = (await allConvs(client, f.workspaceId)).map(stable);
        await runBackfill(client);
        const second = (await allConvs(client, f.workspaceId)).map(stable);
        expect(second).toEqual(first);
      }));
  });
});
