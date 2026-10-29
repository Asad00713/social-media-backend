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

  it('bulk later, assign and unread go through the same paths', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const c1 = await seedConversation(client, db, workspaceId, ch, 'a1');
      const member = await seedMember(client, workspaceId, 'MEMBER');
      const { svc, schedule, assigned } = build(db);

      const later = await svc.bulk(
        workspaceId,
        ownerId,
        { ids: [c1], action: 'later', laterUntil: '2026-11-01T08:00:00.000Z' },
        NOW,
      );
      expect(later.rows[0].status).toBe('later');
      expect(schedule).toHaveBeenCalledTimes(1);

      const assign = await svc.bulk(workspaceId, ownerId, {
        ids: [c1],
        action: 'assign',
        assigneeUserId: member,
      });
      expect(assign.rows[0].assignee?.id).toBe(member);
      expect(assigned).toHaveBeenCalledTimes(1);

      await svc.markRead(workspaceId, c1);
      const unread = await svc.bulk(workspaceId, ownerId, {
        ids: [c1],
        action: 'unread',
      });
      expect(unread.rows[0].unreadCount).toBe(1);
      expect(unread.undo.previous[c1]).toEqual({});
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
      expect(removed).toHaveBeenCalledWith(workspaceId, id);

      const restored = await svc.restore(workspaceId, id);
      expect(restored.row.id).toBe(id);
      expect(await archivedAt(client, id)).toBeNull();
      expect(await ids()).toEqual([id]);
    }));
});
