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
import type { ListConversationsQueryDto } from '../dto/list-conversations.query';
import { ConversationListService } from './conversation-list.service';
import { ConversationPresenter } from './conversation-presenter.service';

const NOW = new Date('2026-10-26T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;
let seq = 0;

interface Over {
  status?: string;
  kind?: string;
  lastMessageAt?: string;
  assignee?: string | null;
  unread?: number;
  archived?: boolean;
  doneAt?: string | null;
  windowAt?: string | null;
  threadKey?: string;
  searchText?: string;
}

async function seedConv(
  client: PoolClient,
  workspaceId: string,
  channelId: number,
  o: Over = {},
): Promise<string> {
  seq += 1;
  const r = await client.query<{ id: string }>(
    `INSERT INTO inbox_conversations
       (workspace_id, channel_id, platform, kind, thread_key, status,
        assignee_user_id, unread_count, last_message_at, last_snippet,
        archived_at, done_at, reply_window_closes_at, search_text,
        later_until_reply)
     VALUES ($1,$2,'facebook',$3,$4,$5,$6,$7,$8,'hello',$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      workspaceId,
      channelId,
      o.kind ?? 'dm',
      o.threadKey ?? `${channelId}:t${seq}`,
      o.status ?? 'to_reply',
      o.assignee ?? null,
      o.unread ?? 0,
      o.lastMessageAt ?? '2026-10-26T10:00:00Z',
      o.archived ? '2026-10-20T00:00:00Z' : null,
      o.doneAt ?? null,
      o.windowAt ?? null,
      o.searchText ?? '',
      o.status === 'later',
    ],
  );
  return r.rows[0].id;
}

async function seedScheduled(
  client: PoolClient,
  workspaceId: string,
  channelId: number,
  convId: string,
  status: string,
  at: string,
): Promise<void> {
  await client.query(
    `INSERT INTO scheduled_inbox_messages
       (workspace_id, channel_id, type, thread_key, text, scheduled_at,
        status, inbox_conversation_id)
     VALUES ($1,$2,'dm','k','t',$3,$4,$5)`,
    [workspaceId, channelId, at, status, convId],
  );
}

const q = (o: Partial<ListConversationsQueryDto> = {}) =>
  ({ view: 'to_reply', ...o }) as ListConversationsQueryDto;

async function setup(db: DbType, client: PoolClient) {
  const { workspaceId, ownerId } = await seedWorkspace(client);
  const ch = await seedChannel(client, workspaceId, 'facebook');
  return {
    workspaceId,
    ownerId,
    ch,
    svc: new ConversationListService(db, new ConversationPresenter(db)),
  };
}

describeInboxDb('ConversationListService', () => {
  it('pages 7 conversations by 3 with identical and microsecond-distinct timestamps, no dup, no gap', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId, ch, svc } = await setup(db, client);
      const times = [
        '2026-10-26T10:00:00.000000Z',
        '2026-10-26T10:00:00.000001Z', // 1 microsecond apart
        '2026-10-26T10:00:00.000001Z', // identical
        '2026-10-26T10:00:00.000001Z', // identical
        '2026-10-26T09:00:00.500000Z',
        '2026-10-26T09:00:00.500000Z',
        '2026-10-25T09:00:00Z',
      ];
      const ids: string[] = [];
      for (const t of times)
        ids.push(await seedConv(client, workspaceId, ch, { lastMessageAt: t }));
      const seen: string[] = [];
      const sizes: number[] = [];
      let cursor: string | undefined;
      let last: string | null = 'start';
      for (let i = 0; i < 5 && last !== null; i += 1) {
        const page = await svc.list(
          workspaceId,
          ownerId,
          q({ limit: 3, cursor }),
          NOW,
        );
        sizes.push(page.rows.length);
        expect(page.total).toBe(7);
        seen.push(...page.rows.map((r) => r.id));
        last = page.nextCursor;
        cursor = page.nextCursor ?? undefined;
      }
      expect(sizes).toEqual([3, 3, 1]);
      expect(last).toBeNull();
      expect(new Set(seen).size).toBe(7);
      expect([...seen].sort()).toEqual([...ids].sort());
    }));

  it('counts conversations, not items (chatty thread)', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId, ch, svc } = await setup(db, client);
      await seedConv(client, workspaceId, ch, { threadKey: `${ch}:chatty` });
      for (let i = 0; i < 200; i += 1) {
        await seedItem(client, {
          workspaceId,
          channelId: ch,
          platform: 'facebook',
          type: 'dm',
          conversationId: 'chatty',
          platformCreatedAt: new Date(NOW.getTime() - i * 1000),
          text: `m${i}`,
        });
      }
      for (let i = 0; i < 5; i += 1) await seedConv(client, workspaceId, ch);
      const page = await svc.list(workspaceId, ownerId, q({ limit: 3 }), NOW);
      expect(page.rows).toHaveLength(3);
      expect(page.total).toBe(6);
    }));

  it('done view keeps 30 days; a search finds older done ones with status done', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId, ch, svc } = await setup(db, client);
      const recent = await seedConv(client, workspaceId, ch, {
        status: 'done',
        doneAt: new Date(NOW.getTime() - 29 * DAY).toISOString(),
      });
      const old = await seedConv(client, workspaceId, ch, {
        status: 'done',
        doneAt: new Date(NOW.getTime() - 31 * DAY).toISOString(),
        searchText: 'refund request',
      });
      const done = await svc.list(
        workspaceId,
        ownerId,
        q({ view: 'done' }),
        NOW,
      );
      expect(done.rows.map((r) => r.id)).toEqual([recent]);
      const found = await svc.list(
        workspaceId,
        ownerId,
        q({ view: 'to_reply', q: 'refund' }),
        NOW,
      );
      expect(found.rows.map((r) => r.id)).toEqual([old]);
      expect(found.rows[0].status).toBe('done');
    }));

  it('scheduled view lists only pending/failed, ordered by send time', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId, ch, svc } = await setup(db, client);
      const later = await seedConv(client, workspaceId, ch);
      const sooner = await seedConv(client, workspaceId, ch, {
        lastMessageAt: '2026-10-20T00:00:00Z',
      });
      const failed = await seedConv(client, workspaceId, ch);
      const sentOnly = await seedConv(client, workspaceId, ch);
      const at = (c: string, s: string, t: string) =>
        seedScheduled(client, workspaceId, ch, c, s, t);
      await at(later, 'pending', '2026-10-30T09:00:00Z');
      await at(sooner, 'pending', '2026-10-28T09:00:00Z');
      await at(sooner, 'pending', '2026-11-05T09:00:00Z');
      await at(failed, 'failed', '2026-10-29T09:00:00Z');
      await at(sentOnly, 'sent', '2026-10-27T09:00:00Z');
      const page = await svc.list(
        workspaceId,
        ownerId,
        q({ view: 'scheduled', limit: 2 }),
        NOW,
      );
      expect(page.rows.map((r) => r.id)).toEqual([sooner, failed]);
      expect(page.total).toBe(3);
      const next = await svc.list(
        workspaceId,
        ownerId,
        q({ view: 'scheduled', limit: 2, cursor: page.nextCursor as string }),
        NOW,
      );
      expect(next.rows.map((r) => r.id)).toEqual([later]);
      expect(next.nextCursor).toBeNull();
    }));

  it('filters by type, channel, assignee, unread and never shows archived', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId, ch, svc } = await setup(db, client);
      const ch2 = await seedChannel(client, workspaceId, 'facebook');
      const mate = await seedMember(client, workspaceId, 'MEMBER', {
        name: 'Mate',
      });
      const dm = await seedConv(client, workspaceId, ch, { kind: 'dm' });
      const cm = await seedConv(client, workspaceId, ch, {
        kind: 'comment_thread',
        assignee: ownerId,
        unread: 2,
      });
      const mn = await seedConv(client, workspaceId, ch2, {
        kind: 'mention',
        assignee: mate,
      });
      await seedConv(client, workspaceId, ch, { archived: true });
      const ids = async (o: Partial<ListConversationsQueryDto>) =>
        (await svc.list(workspaceId, ownerId, q(o), NOW)).rows
          .map((r) => r.id)
          .sort();
      expect(await ids({})).toEqual([dm, cm, mn].sort());
      expect(await ids({ type: 'message' })).toEqual([dm]);
      expect(await ids({ type: 'comment' })).toEqual([cm]);
      expect(await ids({ type: 'mention' })).toEqual([mn]);
      expect(await ids({ channelIds: [ch2] })).toEqual([mn]);
      expect(await ids({ channelIds: [ch, ch2] })).toEqual([dm, cm, mn].sort());
      expect(await ids({ assigned: 'me' })).toEqual([cm]);
      expect(await ids({ assigned: 'unassigned' })).toEqual([dm]);
      expect(await ids({ unread: true })).toEqual([cm]);
    }));

  it('searches older item text, escapes %, and ignores one-character queries', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId, ch, svc } = await setup(db, client);
      const a = await seedConv(client, workspaceId, ch, {
        threadKey: `${ch}:alpha`,
        searchText: 'newest words',
      });
      await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'facebook',
        type: 'dm',
        conversationId: 'alpha',
        platformCreatedAt: new Date('2026-10-01T00:00:00Z'),
        text: 'Pumpkin latte please',
      });
      const b = await seedConv(client, workspaceId, ch, {
        searchText: 'only 50% off today',
      });
      const c = await seedConv(client, workspaceId, ch, {
        searchText: 'about 500 things',
      });
      // A DONE conversation containing "a": it is outside the to_reply view,
      // so it only shows up if the one-letter query were (wrongly) applied.
      const doneA = await seedConv(client, workspaceId, ch, {
        status: 'done',
        doneAt: new Date(NOW.getTime() - DAY).toISOString(),
        searchText: 'a done thread',
      });
      const ids = async (s: string) =>
        (await svc.list(workspaceId, ownerId, q({ q: s }), NOW)).rows
          .map((r) => r.id)
          .sort();
      expect(await ids('pumpkin')).toEqual([a]);
      expect(await ids('50%')).toEqual([b]);
      expect(await ids('a')).toEqual([a, b, c].sort());
      expect(await ids('a')).not.toContain(doneA);
    }));

  it('stays inside its workspace for list, total and search', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId, ch, svc } = await setup(db, client);
      const other = await seedWorkspace(client);
      const otherCh = await seedChannel(client, other.workspaceId, 'facebook');
      const mine = await seedConv(client, workspaceId, ch, {
        threadKey: `${otherCh}:shared`,
        searchText: 'unrelated words',
        unread: 1,
        assignee: ownerId,
      });
      // Same text, kind, status, unread and assignee shape, other workspace.
      await seedConv(client, other.workspaceId, otherCh, {
        searchText: 'pumpkin latte',
        unread: 1,
        assignee: other.ownerId,
      });
      // An item in the other workspace whose thread_key equals one of ours.
      await seedItem(client, {
        workspaceId: other.workspaceId,
        channelId: otherCh,
        platform: 'facebook',
        type: 'dm',
        conversationId: 'shared',
        platformCreatedAt: new Date('2026-10-01T00:00:00Z'),
        text: 'Pumpkin latte please',
      });
      const list = await svc.list(workspaceId, ownerId, q(), NOW);
      expect(list.rows.map((r) => r.id)).toEqual([mine]);
      expect(list.total).toBe(1);
      const filtered = await svc.list(
        workspaceId,
        ownerId,
        q({ unread: true, assigned: 'me', type: 'message' }),
        NOW,
      );
      expect(filtered.total).toBe(1);
      const found = await svc.list(
        workspaceId,
        ownerId,
        q({ q: 'pumpkin' }),
        NOW,
      );
      expect(found.rows).toEqual([]);
      expect(found.total).toBe(0);
    }));

  it('sort=window: 2h before 20h before no window', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId, ch, svc } = await setup(db, client);
      const none = await seedConv(client, workspaceId, ch);
      const h20 = await seedConv(client, workspaceId, ch, {
        windowAt: new Date(NOW.getTime() + 20 * HOUR).toISOString(),
      });
      const h2 = await seedConv(client, workspaceId, ch, {
        windowAt: new Date(NOW.getTime() + 2 * HOUR).toISOString(),
      });
      const none2 = await seedConv(client, workspaceId, ch);
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 5; i += 1) {
        const p = await svc.list(
          workspaceId,
          ownerId,
          q({ sort: 'window', limit: 1, cursor }),
          NOW,
        );
        seen.push(...p.rows.map((r) => r.id));
        if (!p.nextCursor) break;
        cursor = p.nextCursor;
      }
      expect(seen.slice(0, 2)).toEqual([h2, h20]);
      expect(seen.slice(2).sort()).toEqual([none, none2].sort());
    }));

  it('applies the defaults itself for a bare {} query', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId, ch, svc } = await setup(db, client);
      const a = await seedConv(client, workspaceId, ch);
      await seedConv(client, workspaceId, ch, {
        status: 'later',
        windowAt: null,
      });
      const page = await svc.list(workspaceId, ownerId, {}, NOW);
      expect(page.rows.map((r) => r.id)).toEqual([a]);
      expect(page.total).toBe(1);
    }));
});
