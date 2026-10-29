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
import { ConversationSyncService } from './services/conversation-sync.service';
import { InboxNotesService } from './services/inbox-notes.service';
import type { InboxNotifyService } from './services/inbox-notify.service';
import type { InboxRealtimeService } from './services/inbox-realtime.service';

const T0 = new Date('2026-10-26T10:00:00.000Z');
const NO_CONV = '00000000-0000-4000-8000-000000000000';

function fake<T>(impl: object): jest.Mocked<T> {
  return impl as unknown as jest.Mocked<T>;
}

function build(db: DbType) {
  const timelineAppended = jest.fn();
  const noteMentioned = jest.fn().mockResolvedValue(undefined);
  const realtime = fake<InboxRealtimeService>({
    conversationChanged: jest.fn(),
    timelineAppended,
  });
  const notify = fake<InboxNotifyService>({ noteMentioned });
  const svc = new InboxNotesService(
    db,
    new WorkspaceRoleService(db),
    notify,
    realtime,
  );
  return { svc, timelineAppended, noteMentioned };
}

async function seedConversation(
  client: PoolClient,
  db: DbType,
  workspaceId: string,
): Promise<string> {
  const channelId = await seedChannel(client, workspaceId, 'instagram');
  const item = await seedItem(client, {
    workspaceId,
    channelId,
    platform: 'instagram',
    type: 'dm',
    conversationId: 'c-1',
    text: 'hello',
    authorHandle: 'maya',
    authorPlatformId: 'p-1',
    platformCreatedAt: T0,
  });
  const realtime = fake<InboxRealtimeService>({
    conversationChanged: jest.fn(),
    conversationRemoved: jest.fn(),
    countsChanged: jest.fn(),
  });
  const res = await new ConversationSyncService(db, realtime).syncThread(
    workspaceId,
    item.threadKey!,
  );
  return res.conversationId!;
}

describeInboxDb('InboxNotesService', () => {
  it('creates a note, resolves mentions, emits after commit and notifies', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const memberId = await seedMember(client, workspaceId, 'MEMBER', {
        name: 'Mia',
      });
      const conv = await seedConversation(client, db, workspaceId);
      const { svc, timelineAppended, noteMentioned } = build(db);
      const entry = await svc.create(workspaceId, conv, ownerId, {
        body: 'look at this @Mia',
        mentionUserIds: [memberId],
      });
      expect(entry).toMatchObject({
        kind: 'note',
        body: 'look at this @Mia',
        canDelete: true,
        author: { id: ownerId, name: 'Owner' },
        mentions: [{ id: memberId, name: 'Mia', avatarUrl: null }],
      });
      expect(timelineAppended).toHaveBeenCalledWith(
        workspaceId,
        conv,
        entry,
        null,
      );
      expect(noteMentioned).toHaveBeenCalledWith({
        workspaceId,
        conversationId: conv,
        mentionedUserIds: [memberId],
        actorUserId: ownerId,
      });
      const rows = await client.query(
        `SELECT body FROM inbox_notes WHERE conversation_id = $1`,
        [conv],
      );
      expect(rows.rowCount).toBe(1);
    }));

  it('allows mentioning the owner and yourself, de-duplicated in order', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const memberId = await seedMember(client, workspaceId, 'MEMBER');
      const conv = await seedConversation(client, db, workspaceId);
      const { svc } = build(db);
      const entry = await svc.create(workspaceId, conv, memberId, {
        body: 'hi',
        mentionUserIds: [ownerId, memberId, ownerId],
      });
      expect(entry.mentions.map((m) => m.id)).toEqual([ownerId, memberId]);
    }));

  it('rejects a mention of a non-member with 400 and writes nothing', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const other = await seedWorkspace(client);
      const conv = await seedConversation(client, db, workspaceId);
      const { svc, timelineAppended, noteMentioned } = build(db);
      await expect(
        svc.create(workspaceId, conv, ownerId, {
          body: 'x',
          mentionUserIds: [other.ownerId],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      const rows = await client.query(`SELECT 1 FROM inbox_notes`);
      expect(rows.rowCount).toBe(0);
      expect(timelineAppended).not.toHaveBeenCalled();
      expect(noteMentioned).not.toHaveBeenCalled();
    }));

  it('rejects a mention of a member whose invitation is still pending', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const pending = await seedMember(client, workspaceId, 'MEMBER');
      await client.query(
        `UPDATE workspace_invitations SET status = 'PENDING' WHERE user_id = $1`,
        [pending],
      );
      const conv = await seedConversation(client, db, workspaceId);
      const { svc } = build(db);
      await expect(
        svc.create(workspaceId, conv, ownerId, {
          body: 'x',
          mentionUserIds: [pending],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }));

  it('404s for a conversation outside the workspace', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const other = await seedWorkspace(client);
      const conv = await seedConversation(client, db, other.workspaceId);
      const { svc } = build(db);
      await expect(
        svc.create(workspaceId, conv, ownerId, {
          body: 'x',
          mentionUserIds: [],
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        svc.create(workspaceId, NO_CONV, ownerId, {
          body: 'x',
          mentionUserIds: [],
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    }));

  it('forbids deleting another member note with 403', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const memberId = await seedMember(client, workspaceId, 'MEMBER');
      const conv = await seedConversation(client, db, workspaceId);
      const { svc } = build(db);
      const note = await svc.create(workspaceId, conv, ownerId, {
        body: 'mine',
        mentionUserIds: [],
      });
      const err: unknown = await svc
        .remove(workspaceId, conv, note.id, memberId)
        .catch((e: unknown) => e);
      expect(err).toMatchObject({
        status: 403,
        message: 'You can only delete your own notes',
      });
      const rows = await client.query(`SELECT 1 FROM inbox_notes`);
      expect(rows.rowCount).toBe(1);
    }));

  it('lets the author delete; clients are told to refetch; unknown is 404', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const conv = await seedConversation(client, db, workspaceId);
      const { svc, timelineAppended } = build(db);
      const note = await svc.create(workspaceId, conv, ownerId, {
        body: 'mine',
        mentionUserIds: [],
      });
      timelineAppended.mockClear();
      await expect(
        svc.remove(workspaceId, conv, note.id, ownerId),
      ).resolves.toEqual({ ok: true });
      const rows = await client.query(`SELECT 1 FROM inbox_notes`);
      expect(rows.rowCount).toBe(0);
      expect(timelineAppended).toHaveBeenCalledWith(
        workspaceId,
        conv,
        null,
        null,
      );
      await expect(
        svc.remove(workspaceId, conv, note.id, ownerId),
      ).rejects.toBeInstanceOf(NotFoundException);
    }));
});
