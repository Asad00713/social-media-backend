import type { PoolClient } from 'pg';
import {
  describeInboxDb,
  seedChannel,
  seedItem,
  seedMember,
  seedWorkspace,
  withInboxDb,
} from '../../testing/inbox-db';
import { ConversationPresenter } from './conversation-presenter.service';

let seq = 0;

async function seedConv(
  client: PoolClient,
  workspaceId: string,
  channelId: number,
  over: {
    status?: string;
    laterUntilReply?: boolean;
    archived?: boolean;
    assignee?: string;
    doneBy?: string;
    threadKey?: string;
  } = {},
): Promise<string> {
  seq += 1;
  const r = await client.query<{ id: string }>(
    `INSERT INTO inbox_conversations
       (workspace_id, channel_id, platform, kind, thread_key, status,
        later_until_reply, assignee_user_id, done_by_user_id, last_message_at,
        last_snippet, archived_at)
     VALUES ($1,$2,'facebook','dm',$3,$4,$5,$6,$7,
             '2026-10-26T10:00:00Z','hello', $8)
     RETURNING id`,
    [
      workspaceId,
      channelId,
      over.threadKey ?? `${channelId}:t${seq}`,
      over.status ?? 'to_reply',
      over.laterUntilReply ?? over.status === 'later',
      over.assignee ?? null,
      over.doneBy ?? null,
      over.archived ? new Date('2026-10-20T00:00:00Z') : null,
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
  by: string | null,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO scheduled_inbox_messages
       (workspace_id, channel_id, type, thread_key, text, scheduled_at,
        status, inbox_conversation_id, created_by_user_id)
     VALUES ($1,$2,'dm','k','t',$3,$4,$5,$6) RETURNING id`,
    [workspaceId, channelId, at, status, convId, by],
  );
  return r.rows[0].id;
}

describeInboxDb('ConversationPresenter', () => {
  describe('loadRows', () => {
    it('keeps the order of ids, ranks failed over pending, and drops foreign ids', () =>
      withInboxDb(async (db, client) => {
        const { workspaceId, ownerId } = await seedWorkspace(client);
        const other = await seedWorkspace(client);
        const mate = await seedMember(client, workspaceId, 'MEMBER', {
          name: 'Mate',
        });
        await client.query(`UPDATE users SET avatar_url = $2 WHERE id = $1`, [
          mate,
          'https://a/mate.png',
        ]);
        const ch = await seedChannel(client, workspaceId, 'facebook', {
          username: '@daybreak.coffee',
        });
        const otherCh = await seedChannel(
          client,
          other.workspaceId,
          'facebook',
        );
        const a = await seedConv(client, workspaceId, ch, {
          assignee: mate,
          doneBy: ownerId,
          status: 'done',
        });
        const b = await seedConv(client, workspaceId, ch);
        const foreign = await seedConv(client, other.workspaceId, otherCh);
        await seedScheduled(
          client,
          workspaceId,
          ch,
          a,
          'pending',
          '2026-10-27T09:00:00Z',
          ownerId,
        );
        const failedId = await seedScheduled(
          client,
          workspaceId,
          ch,
          a,
          'failed',
          '2026-10-28T09:00:00Z',
          mate,
        );
        // sent / cancelled replies never surface
        await seedScheduled(
          client,
          workspaceId,
          ch,
          b,
          'sent',
          '2026-10-27T09:00:00Z',
          null,
        );

        const presenter = new ConversationPresenter(db);
        const rows = await presenter.loadRows(
          workspaceId,
          [b, a, foreign],
          new Date('2026-10-26T12:00:00Z'),
        );
        expect(rows.map((r) => r.id)).toEqual([b, a]);
        expect(rows[0].scheduled).toBeNull();
        expect(rows[0].channelLabel).toBe('daybreak.coffee');
        expect(rows[1].scheduled).toEqual({
          id: failedId,
          sendAt: '2026-10-28T09:00:00.000Z',
          by: { id: mate, name: 'Mate', avatarUrl: 'https://a/mate.png' },
          status: 'failed',
        });
        expect(rows[1].assignee).toEqual({
          id: mate,
          name: 'Mate',
          avatarUrl: 'https://a/mate.png',
        });
        expect(rows[1].doneBy).toEqual({
          id: ownerId,
          name: 'Owner',
          avatarUrl: null,
        });
        expect(rows[1].assignedBy).toBeNull();
      }));

    it('returns archived rows too (D7) and an empty list for no ids', () =>
      withInboxDb(async (db, client) => {
        const { workspaceId } = await seedWorkspace(client);
        const ch = await seedChannel(client, workspaceId, 'facebook');
        const c = await seedConv(client, workspaceId, ch, { archived: true });
        const presenter = new ConversationPresenter(db);
        expect(
          (await presenter.loadRows(workspaceId, [c])).map((r) => r.id),
        ).toEqual([c]);
        expect(await presenter.loadRows(workspaceId, [])).toEqual([]);
      }));

    it('loads one row by thread key, and null for an unknown key', () =>
      withInboxDb(async (db, client) => {
        const { workspaceId } = await seedWorkspace(client);
        const ch = await seedChannel(client, workspaceId, 'facebook');
        const c = await seedConv(client, workspaceId, ch, {
          threadKey: `${ch}:abc`,
        });
        const presenter = new ConversationPresenter(db);
        expect(
          (await presenter.loadRowByThreadKey(workspaceId, `${ch}:abc`))?.id,
        ).toBe(c);
        expect(
          await presenter.loadRowByThreadKey(workspaceId, 'nope'),
        ).toBeNull();
      }));
  });

  describe('counts', () => {
    it('counts to_reply, later and scheduled, skipping archived', () =>
      withInboxDb(async (db, client) => {
        const { workspaceId, ownerId } = await seedWorkspace(client);
        const ch = await seedChannel(client, workspaceId, 'facebook');
        const first = await seedConv(client, workspaceId, ch);
        await seedConv(client, workspaceId, ch);
        await seedConv(client, workspaceId, ch, { archived: true });
        await seedConv(client, workspaceId, ch, { status: 'later' });
        await seedScheduled(
          client,
          workspaceId,
          ch,
          first,
          'pending',
          '2026-10-27T09:00:00Z',
          ownerId,
        );
        // two live replies on one conversation still count it once
        await seedScheduled(
          client,
          workspaceId,
          ch,
          first,
          'failed',
          '2026-10-27T10:00:00Z',
          ownerId,
        );
        const counts = await new ConversationPresenter(db).counts(
          workspaceId,
          new Date('2026-10-26T12:00:00Z'),
        );
        expect(counts).toMatchObject({ toReply: 2, later: 1, scheduled: 1 });
        expect(counts.answeredToday).toEqual({ total: 0, by: [] });
      }));

    it('answeredToday uses the workspace day, only authored replies, ranked by count', () =>
      withInboxDb(async (db, client) => {
        const { workspaceId, ownerId } = await seedWorkspace(client, {
          timezone: 'Asia/Karachi',
        });
        const mate = await seedMember(client, workspaceId, 'MEMBER', {
          name: 'Mate',
        });
        const ch = await seedChannel(client, workspaceId, 'facebook');
        const reply = (
          conversationId: string,
          at: string,
          authoredByUserId: string | null,
        ) =>
          seedItem(client, {
            workspaceId,
            channelId: ch,
            platform: 'facebook',
            type: 'dm',
            conversationId,
            fromMe: true,
            authoredByUserId,
            platformCreatedAt: new Date(at),
          });
        // now = 01:00 on 27 Oct in Karachi, so "today" starts 26 Oct 19:00Z
        await reply('c1', '2026-10-26T19:30:00Z', ownerId); // 00:30 local: today
        await reply('c2', '2026-10-26T19:45:00Z', mate); // today
        await reply('c3', '2026-10-26T19:50:00Z', mate); // today
        await reply('c4', '2026-10-26T18:30:00Z', ownerId); // 23:30 local: yesterday
        await reply('c5', '2026-10-26T19:35:00Z', null); // platform reply: never

        const { answeredToday } = await new ConversationPresenter(db).counts(
          workspaceId,
          new Date('2026-10-26T20:00:00Z'),
        );
        expect(answeredToday.total).toBe(3);
        expect(answeredToday.by.map((u) => u.id)).toEqual([mate, ownerId]);
        expect(answeredToday.by[0]).toEqual({
          id: mate,
          name: 'Mate',
          avatarUrl: null,
        });
      }));
  });
});
