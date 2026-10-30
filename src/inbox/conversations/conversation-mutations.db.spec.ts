import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { DbType } from '../../drizzle/db';
import { WorkspaceRoleService } from '../../workspace-members/workspace-role.service';
import {
  describeInboxDb,
  seedChannel,
  seedItem,
  seedMember,
  seedWorkspace,
  withInboxDb,
} from '../testing/inbox-db';
import type { PatchConversationDto } from './dto/patch-conversation.dto';
import { ConversationListService } from './services/conversation-list.service';
import { ConversationMutationsService } from './services/conversation-mutations.service';
import { ConversationPresenter } from './services/conversation-presenter.service';
import { ConversationSyncService } from './services/conversation-sync.service';
import type { InboxNotifyService } from './services/inbox-notify.service';
import type { InboxRealtimeService } from './services/inbox-realtime.service';
import type { LaterWakeService } from './services/later-wake.service';

const T0 = new Date('2026-10-26T10:00:00.000Z');
const NOW = new Date('2026-10-26T12:00:00.000Z');
const OTHER_WS_CONV = '00000000-0000-4000-8000-000000000000';

function fake<T>(impl: object): jest.Mocked<T> {
  return impl as unknown as jest.Mocked<T>;
}

function build(db: DbType) {
  const removed = jest.fn();
  const realtime = fake<InboxRealtimeService>({
    conversationChanged: jest.fn(),
    conversationRemoved: removed,
    countsChanged: jest.fn(),
    timelineAppended: jest.fn(),
  });
  const assigned = jest.fn().mockResolvedValue(undefined);
  const schedule = jest
    .fn<Promise<void>, Parameters<LaterWakeService['schedule']>>()
    .mockResolvedValue(undefined);
  const notify = fake<InboxNotifyService>({ assigned });
  const wake = fake<LaterWakeService>({ schedule });
  const presenter = new ConversationPresenter(db);
  const svc = new ConversationMutationsService(
    db,
    new ConversationSyncService(db, realtime),
    presenter,
    new WorkspaceRoleService(db),
    notify,
    wake,
    realtime,
  );
  const list = new ConversationListService(db, presenter);
  return { svc, assigned, schedule, removed, list };
}

async function seedDm(
  client: PoolClient,
  workspaceId: string,
  channelId: number,
  convo: string,
  extra: { minutes?: number } = {},
) {
  const item = await seedItem(client, {
    workspaceId,
    channelId,
    platform: 'instagram',
    type: 'dm',
    conversationId: convo,
    text: 'hello',
    authorHandle: 'maya',
    authorPlatformId: `p-${convo}`,
    platformCreatedAt: new Date(T0.getTime() + (extra.minutes ?? 0) * 60_000),
  });
  return item.threadKey!;
}

/** Seeds a DM thread and brings the conversation row into being. */
async function seedConversation(
  client: PoolClient,
  db: DbType,
  workspaceId: string,
  channelId: number,
  convo: string,
): Promise<string> {
  const key = await seedDm(client, workspaceId, channelId, convo);
  const res = await new ConversationSyncService(
    db,
    fake<InboxRealtimeService>({
      conversationChanged: jest.fn(),
      conversationRemoved: jest.fn(),
      countsChanged: jest.fn(),
    }),
  ).syncThread(workspaceId, key);
  return res.conversationId!;
}

/** A thread holding only our own outbound message: nothing to mark unread. */
async function seedOutboundOnly(
  client: PoolClient,
  db: DbType,
  workspaceId: string,
  channelId: number,
  convo: string,
): Promise<string> {
  const item = await seedItem(client, {
    workspaceId,
    channelId,
    platform: 'instagram',
    type: 'dm',
    conversationId: convo,
    fromMe: true,
    status: 'replied',
    text: 'hi',
    authorPlatformId: `p-${convo}`,
    platformCreatedAt: T0,
  });
  const res = await new ConversationSyncService(
    db,
    fake<InboxRealtimeService>({
      conversationChanged: jest.fn(),
      conversationRemoved: jest.fn(),
      countsChanged: jest.fn(),
    }),
  ).syncThread(workspaceId, item.threadKey!);
  return res.conversationId!;
}

const archivedAt = async (client: PoolClient, id: string) =>
  (
    await client.query<{ archived_at: Date | null }>(
      `SELECT archived_at FROM inbox_conversations WHERE id = $1`,
      [id],
    )
  ).rows[0].archived_at;

describeInboxDb('ConversationMutationsService', () => {
  it('PATCH done, then the returned undo restores to_reply', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const id = await seedConversation(client, db, workspaceId, ch, 'a');
      const { svc } = build(db);

      const done = await svc.patch(workspaceId, id, ownerId, {
        status: 'done',
      });
      expect(done.row.status).toBe('done');
      expect(done.row.doneVia).toBe('manual');
      expect(done.undo).toEqual({ status: 'to_reply' });

      const back = await svc.patch(
        workspaceId,
        id,
        ownerId,
        done.undo as PatchConversationDto,
      );
      expect(back.row.status).toBe('to_reply');
      expect(back.row.doneVia).toBeNull();
    }));

  it('answers 404 for a conversation of another workspace', () =>
    withInboxDb(async (db, client) => {
      const a = await seedWorkspace(client);
      const b = await seedWorkspace(client);
      const ch = await seedChannel(client, a.workspaceId, 'instagram');
      const id = await seedConversation(client, db, a.workspaceId, ch, 'a');
      const { svc } = build(db);
      await expect(
        svc.patch(b.workspaceId, id, b.ownerId, { status: 'done' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        svc.patch(a.workspaceId, OTHER_WS_CONV, a.ownerId, { status: 'done' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    }));

  it('Later: preset resolves in the workspace zone and schedules the wake', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client, {
        timezone: 'Asia/Karachi',
      });
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const id = await seedConversation(client, db, workspaceId, ch, 'a');
      const { svc, schedule } = build(db);

      const res = await svc.patch(
        workspaceId,
        id,
        ownerId,
        { status: 'later', laterPreset: 'tomorrow' },
        NOW,
      );
      expect(res.row.status).toBe('later');
      expect(res.row.laterUntil).toBe('2026-10-27T04:00:00.000Z');
      expect(schedule).toHaveBeenCalledTimes(1);
      const [convId, until, at] = schedule.mock.calls[0];
      expect(convId).toBe(id);
      expect(until.toISOString()).toBe('2026-10-27T04:00:00.000Z');
      expect(at).toBe(NOW);
    }));

  it('Later: an explicit laterUntil is used; laterUntilReply schedules nothing', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const id = await seedConversation(client, db, workspaceId, ch, 'a');
      const { svc, schedule } = build(db);

      const timed = await svc.patch(
        workspaceId,
        id,
        ownerId,
        { status: 'later', laterUntil: '2026-11-01T08:00:00.000Z' },
        NOW,
      );
      expect(timed.row.laterUntil).toBe('2026-11-01T08:00:00.000Z');
      expect(schedule).toHaveBeenCalledTimes(1);

      const reply = await svc.patch(
        workspaceId,
        id,
        ownerId,
        { status: 'later', laterUntilReply: true },
        NOW,
      );
      expect(reply.row.laterUntil).toBeNull();
      expect(reply.row.laterUntilReply).toBe(true);
      expect(schedule).toHaveBeenCalledTimes(1);
      // Undo of the second patch brings back the first snooze.
      expect(reply.undo).toEqual({
        status: 'later',
        laterUntil: '2026-11-01T08:00:00.000Z',
        laterUntilReply: false,
      });
    }));

  it('Later: nothing to wake on, or later_today after 18:00 local, is a 400', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const id = await seedConversation(client, db, workspaceId, ch, 'a');
      const { svc, schedule } = build(db);

      await expect(
        svc.patch(workspaceId, id, ownerId, { status: 'later' }, NOW),
      ).rejects.toBeInstanceOf(BadRequestException);
      const late = new Date('2026-10-26T19:00:00.000Z');
      await expect(
        svc.patch(
          workspaceId,
          id,
          ownerId,
          { status: 'later', laterPreset: 'later_today' },
          late,
        ),
      ).rejects.toThrow('That time has passed');
      expect(schedule).not.toHaveBeenCalled();
    }));

  it('assign: a GUEST is refused, a MEMBER is set and notified, null clears', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const id = await seedConversation(client, db, workspaceId, ch, 'a');
      const guest = await seedMember(client, workspaceId, 'GUEST');
      const member = await seedMember(client, workspaceId, 'MEMBER');
      const stranger = (await seedWorkspace(client)).ownerId;
      const { svc, assigned } = build(db);

      for (const bad of [guest, stranger]) {
        await expect(
          svc.patch(workspaceId, id, ownerId, { assigneeUserId: bad }),
        ).rejects.toThrow('Assignee must be a member who can reply');
      }
      expect(assigned).not.toHaveBeenCalled();

      const res = await svc.patch(
        workspaceId,
        id,
        ownerId,
        { assigneeUserId: member },
        NOW,
      );
      expect(res.row.assignee?.id).toBe(member);
      expect(res.undo).toEqual({ assigneeUserId: null });
      expect(assigned).toHaveBeenCalledWith({
        workspaceId,
        conversationId: id,
        assigneeUserId: member,
        actorUserId: ownerId,
      });

      // Re-assigning the same person does not notify again.
      await svc.patch(workspaceId, id, ownerId, { assigneeUserId: member });
      expect(assigned).toHaveBeenCalledTimes(1);

      const cleared = await svc.patch(workspaceId, id, ownerId, {
        assigneeUserId: null,
      });
      expect(cleared.row.assignee).toBeNull();
      expect(cleared.undo).toEqual({ assigneeUserId: member });
      expect(assigned).toHaveBeenCalledTimes(1);
    }));

  it('bulk done skips ids of another workspace and records undo per id', () =>
    withInboxDb(async (db, client) => {
      const a = await seedWorkspace(client);
      const b = await seedWorkspace(client);
      const cha = await seedChannel(client, a.workspaceId, 'instagram');
      const chb = await seedChannel(client, b.workspaceId, 'instagram');
      const c1 = await seedConversation(client, db, a.workspaceId, cha, 'a1');
      const c2 = await seedConversation(client, db, a.workspaceId, cha, 'a2');
      const foreign = await seedConversation(
        client,
        db,
        b.workspaceId,
        chb,
        'b1',
      );
      const { svc } = build(db);

      const res = await svc.bulk(a.workspaceId, a.ownerId, {
        ids: [c1, foreign, c2],
        action: 'done',
      });
      expect(res.rows.map((r) => r.id).sort()).toEqual([c1, c2].sort());
      expect(res.rows.every((r) => r.status === 'done')).toBe(true);
      expect(Object.keys(res.undo.previous).sort()).toEqual([c1, c2].sort());
      expect(res.undo.previous[c1]).toEqual({ status: 'to_reply' });
      expect(res.undo.ids.sort()).toEqual([c1, c2].sort());
      const untouched = await client.query<{ status: string }>(
        `SELECT status FROM inbox_conversations WHERE id = $1`,
        [foreign],
      );
      expect(untouched.rows[0].status).toBe('to_reply');
    }));

  it('bulk later, assign and unread act on EVERY row', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const ids = [
        await seedConversation(client, db, workspaceId, ch, 'a1'),
        await seedConversation(client, db, workspaceId, ch, 'a2'),
        await seedConversation(client, db, workspaceId, ch, 'a3'),
      ];
      const member = await seedMember(client, workspaceId, 'MEMBER');
      const { svc, schedule, assigned } = build(db);

      const later = await svc.bulk(
        workspaceId,
        ownerId,
        { ids, action: 'later', laterUntil: '2026-11-01T08:00:00.000Z' },
        NOW,
      );
      expect(later.rows).toHaveLength(3);
      for (const r of later.rows) {
        expect(r.status).toBe('later');
        expect(r.laterUntil).toBe('2026-11-01T08:00:00.000Z');
      }
      expect(schedule).toHaveBeenCalledTimes(3);
      expect([...later.undo.ids].sort()).toEqual([...ids].sort());
      for (const id of ids) {
        expect(later.undo.previous[id]).toEqual({ status: 'to_reply' });
      }

      const assign = await svc.bulk(workspaceId, ownerId, {
        ids,
        action: 'assign',
        assigneeUserId: member,
      });
      expect(assign.rows).toHaveLength(3);
      for (const r of assign.rows) expect(r.assignee?.id).toBe(member);
      expect(assigned).toHaveBeenCalledTimes(3);
      for (const id of ids) {
        expect(assign.undo.previous[id]).toEqual({ assigneeUserId: null });
      }

      for (const id of ids) await svc.markRead(workspaceId, id);
      const unread = await svc.bulk(workspaceId, ownerId, {
        ids,
        action: 'unread',
      });
      expect(unread.rows).toHaveLength(3);
      for (const r of unread.rows) expect(r.unreadCount).toBe(1);
      for (const id of ids) expect(unread.undo.previous[id]).toEqual({});
    }));

  it('bulk unread skips a thread with nothing inbound, and says so by omission', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const withInbound = await seedConversation(
        client,
        db,
        workspaceId,
        ch,
        'i',
      );
      const outboundOnly = await seedOutboundOnly(
        client,
        db,
        workspaceId,
        ch,
        'o',
      );
      const { svc } = build(db);
      const res = await svc.bulk(workspaceId, ownerId, {
        ids: [outboundOnly, withInbound],
        action: 'unread',
      });
      expect(res.rows.map((r) => r.id)).toEqual([withInbound]);
      expect(res.undo.ids).toEqual([withInbound]);
      expect(Object.keys(res.undo.previous)).toEqual([withInbound]);
    }));

  it('read marks every inbound item needs_reply; unread flips the latest back', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const id = await seedConversation(client, db, workspaceId, ch, 'a');
      await seedDm(client, workspaceId, ch, 'a', { minutes: 5 });
      await new ConversationSyncService(
        db,
        fake<InboxRealtimeService>({
          conversationChanged: jest.fn(),
          conversationRemoved: jest.fn(),
          countsChanged: jest.fn(),
        }),
      ).syncThread(
        workspaceId,
        (
          await client.query<{ thread_key: string }>(
            `SELECT thread_key FROM inbox_conversations WHERE id = $1`,
            [id],
          )
        ).rows[0].thread_key,
      );
      const { svc } = build(db);

      const before = await svc.markUnread(workspaceId, id, ownerId);
      expect(before.row.unreadCount).toBeGreaterThan(0);
      const read = await svc.markRead(workspaceId, id);
      expect(read.row.unreadCount).toBe(0);
      const items = await client.query<{ status: string }>(
        `SELECT status FROM inbox_items WHERE workspace_id = $1`,
        [workspaceId],
      );
      expect(items.rows).toHaveLength(2);
      expect(items.rows.every((r) => r.status === 'needs_reply')).toBe(true);

      const unread = await svc.markUnread(workspaceId, id, ownerId);
      expect(unread.row.unreadCount).toBe(1);
      expect(unread.undo).toBeNull();
    }));

  it('unread on a thread with no inbound row is a 400', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const item = await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'instagram',
        type: 'dm',
        conversationId: 'out',
        fromMe: true,
        status: 'replied',
        text: 'hi',
        authorPlatformId: 'p-out',
        platformCreatedAt: T0,
      });
      const res = await new ConversationSyncService(
        db,
        fake<InboxRealtimeService>({
          conversationChanged: jest.fn(),
          conversationRemoved: jest.fn(),
          countsChanged: jest.fn(),
        }),
      ).syncThread(workspaceId, item.threadKey!);
      const { svc } = build(db);
      await expect(
        svc.markUnread(workspaceId, res.conversationId!, ownerId),
      ).rejects.toThrow('Nothing to mark unread');
    }));

  it('remove archives the whole thread and the list drops it; restore brings it back', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const id = await seedConversation(client, db, workspaceId, ch, 'a');
      const { svc, list, removed } = build(db);
      const ids = async () =>
        (
          await list.list(workspaceId, ownerId, { view: 'to_reply' }, NOW)
        ).rows.map((r) => r.id);
      expect(await ids()).toEqual([id]);

      expect(await svc.remove(workspaceId, id)).toEqual({ ok: true });
      expect(await archivedAt(client, id)).not.toBeNull();
      expect(await ids()).toEqual([]);
      expect(removed).toHaveBeenCalledTimes(1);
      expect(removed).toHaveBeenCalledWith(workspaceId, id);

      const restored = await svc.restore(workspaceId, id);
      expect(restored.row.id).toBe(id);
      expect(await archivedAt(client, id)).toBeNull();
      expect(await ids()).toEqual([id]);
    }));

  it('Later preset: later_today is judged in the workspace zone, not UTC', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client, {
        timezone: 'Asia/Karachi',
      });
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const id = await seedConversation(client, db, workspaceId, ch, 'a');
      const { svc } = build(db);
      // 13:30Z is 18:30 in Karachi (passed), though only 13:30 in UTC.
      await expect(
        svc.patch(
          workspaceId,
          id,
          ownerId,
          { status: 'later', laterPreset: 'later_today' },
          new Date('2026-10-26T13:30:00.000Z'),
        ),
      ).rejects.toThrow('That time has passed');
      // 12:00Z is 17:00 in Karachi: 18:00 local is 13:00Z (UTC would say 18:00Z).
      const ok = await svc.patch(
        workspaceId,
        id,
        ownerId,
        { status: 'later', laterPreset: 'later_today' },
        NOW,
      );
      expect(ok.row.laterUntil).toBe('2026-10-26T13:00:00.000Z');
    }));

  it('replaying the undo of a Later snooze restores the exact time and re-schedules it', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const id = await seedConversation(client, db, workspaceId, ch, 'a');
      const { svc, schedule } = build(db);
      const X = '2026-11-01T08:00:00.000Z';
      await svc.patch(
        workspaceId,
        id,
        ownerId,
        { status: 'later', laterUntil: X },
        NOW,
      );

      const done = await svc.patch(
        workspaceId,
        id,
        ownerId,
        { status: 'done' },
        NOW,
      );
      expect(done.row.status).toBe('done');
      schedule.mockClear();
      const back = await svc.patch(
        workspaceId,
        id,
        ownerId,
        done.undo as PatchConversationDto,
        NOW,
      );
      expect(back.row.status).toBe('later');
      expect(back.row.laterUntil).toBe(X);
      expect(back.row.laterUntilReply).toBe(false);
      expect(back.row.doneVia).toBeNull();
      expect(schedule).toHaveBeenCalledTimes(1);
      expect(schedule.mock.calls[0][1].toISOString()).toBe(X);

      // A later-until-reply snooze comes back as such.
      await svc.patch(
        workspaceId,
        id,
        ownerId,
        { status: 'later', laterUntilReply: true },
        NOW,
      );
      const done2 = await svc.patch(
        workspaceId,
        id,
        ownerId,
        { status: 'done' },
        NOW,
      );
      const back2 = await svc.patch(
        workspaceId,
        id,
        ownerId,
        done2.undo as PatchConversationDto,
        NOW,
      );
      expect(back2.row.status).toBe('later');
      expect(back2.row.laterUntil).toBeNull();
      expect(back2.row.laterUntilReply).toBe(true);
    }));

  it('replaying the undo of an assignment restores the previous assignee', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const id = await seedConversation(client, db, workspaceId, ch, 'a');
      const m1 = await seedMember(client, workspaceId, 'MEMBER');
      const m2 = await seedMember(client, workspaceId, 'ADMIN');
      const { svc } = build(db);
      await svc.patch(workspaceId, id, ownerId, { assigneeUserId: m1 });
      const second = await svc.patch(workspaceId, id, ownerId, {
        assigneeUserId: m2,
      });
      expect(second.row.assignee?.id).toBe(m2);
      const back = await svc.patch(
        workspaceId,
        id,
        ownerId,
        second.undo as PatchConversationDto,
      );
      expect(back.row.assignee?.id).toBe(m1);
      const first = await svc.patch(workspaceId, id, ownerId, {
        assigneeUserId: null,
      });
      const again = await svc.patch(
        workspaceId,
        id,
        ownerId,
        first.undo as PatchConversationDto,
      );
      expect(again.row.assignee?.id).toBe(m1);
    }));

  it('later fields without status later are a 400 and change nothing', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const id = await seedConversation(client, db, workspaceId, ch, 'a');
      const { svc, schedule } = build(db);
      await svc.patch(
        workspaceId,
        id,
        ownerId,
        { status: 'later', laterUntil: '2026-11-01T08:00:00.000Z' },
        NOW,
      );
      schedule.mockClear();
      const bodies: PatchConversationDto[] = [
        { laterUntil: '2026-11-02T08:00:00.000Z' },
        { laterPreset: 'tomorrow' },
        { laterUntilReply: true },
        { status: 'done', laterUntil: '2026-11-02T08:00:00.000Z' },
      ];
      for (const body of bodies) {
        await expect(
          svc.patch(workspaceId, id, ownerId, body, NOW),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(schedule).not.toHaveBeenCalled();
      const [row] = await new ConversationPresenter(db).loadRows(workspaceId, [
        id,
      ]);
      expect(row.status).toBe('later');
      expect(row.laterUntil).toBe('2026-11-01T08:00:00.000Z');
    }));

  it('bulk assign needs assigneeUserId: missing is a 400, explicit null unassigns', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const id = await seedConversation(client, db, workspaceId, ch, 'a');
      const member = await seedMember(client, workspaceId, 'MEMBER');
      const { svc } = build(db);
      await svc.patch(workspaceId, id, ownerId, { assigneeUserId: member });
      await expect(
        svc.bulk(workspaceId, ownerId, { ids: [id], action: 'assign' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      const [still] = await new ConversationPresenter(db).loadRows(
        workspaceId,
        [id],
      );
      expect(still.assignee?.id).toBe(member);

      const res = await svc.bulk(workspaceId, ownerId, {
        ids: [id],
        action: 'assign',
        assigneeUserId: null,
      });
      expect(res.rows[0].assignee).toBeNull();
      expect(res.undo.previous[id]).toEqual({ assigneeUserId: member });
    }));

  it('a failing wake.schedule after the commit does not fail the PATCH', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const id = await seedConversation(client, db, workspaceId, ch, 'a');
      const { svc, schedule } = build(db);
      schedule.mockRejectedValueOnce(new Error('redis down'));
      const res = await svc.patch(
        workspaceId,
        id,
        ownerId,
        { status: 'later', laterUntil: '2026-11-01T08:00:00.000Z' },
        NOW,
      );
      expect(res.row.status).toBe('later');
      expect(res.undo).toEqual({ status: 'to_reply' });
    }));

  it('every single-conversation mutation answers 404 across workspaces and changes nothing', () =>
    withInboxDb(async (db, client) => {
      const a = await seedWorkspace(client);
      const b = await seedWorkspace(client);
      const ch = await seedChannel(client, a.workspaceId, 'instagram');
      const id = await seedConversation(client, db, a.workspaceId, ch, 'a');
      const { svc } = build(db);
      const ws = b.workspaceId;
      await expect(svc.markRead(ws, id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(svc.markUnread(ws, id, b.ownerId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(svc.remove(ws, id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(svc.restore(ws, id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(await archivedAt(client, id)).toBeNull();
      const items = await client.query<{
        status: string;
        archived_at: Date | null;
      }>(
        `SELECT status, archived_at FROM inbox_items WHERE workspace_id = $1`,
        [a.workspaceId],
      );
      expect(items.rows).toEqual([{ status: 'unread', archived_at: null }]);
    }));
});
