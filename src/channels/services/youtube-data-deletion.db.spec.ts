import {
  describeInboxDb,
  seedChannel,
  seedItem,
  seedMember,
  seedWorkspace,
  withInboxDb,
} from '../../inbox/testing/inbox-db';
import { ConversationPresenter } from '../../inbox/conversations/services/conversation-presenter.service';
import { ConversationSyncService } from '../../inbox/conversations/services/conversation-sync.service';
import { ConversationResyncService } from '../../inbox/conversations/services/conversation-resync.service';
import { YoutubeDataDeletionService } from './youtube-data-deletion.service';

const T0 = new Date('2026-10-26T10:00:00.000Z');

const rt = {
  conversationChanged: jest.fn(),
  conversationRemoved: jest.fn(),
  countsChanged: jest.fn(),
  timelineAppended: jest.fn(),
};

describeInboxDb('YoutubeDataDeletionService x conversations', () => {
  it('removes the deleted channel conversations, sweeps leftovers, and leaves other channels alone', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const chA = await seedChannel(client, workspaceId, 'youtube');
      const chB = await seedChannel(client, workspaceId, 'youtube');
      const sync = new ConversationSyncService(db, rt as never);
      const service = new YoutubeDataDeletionService(
        db,
        new ConversationResyncService({ add: jest.fn() } as never, sync),
      );
      const seed = (channelId: number, post: string) =>
        seedItem(client, {
          workspaceId,
          channelId,
          platform: 'youtube',
          type: 'comment',
          platformPostId: post,
          text: 'a comment',
          authorHandle: 'fan',
          platformCreatedAt: T0,
        });
      const a = await seed(chA, 'va');
      const b = await seed(chB, 'vb');
      await sync.syncThread(workspaceId, a.threadKey!);
      await sync.syncThread(workspaceId, b.threadKey!);
      // A conversation left behind by an earlier run whose sync failed: its
      // items are already gone, so the DELETE's RETURNING cannot name it.
      const leftover = await seed(chA, 'v-left');
      await sync.syncThread(workspaceId, leftover.threadKey!);
      await client.query(`DELETE FROM inbox_items WHERE id = $1`, [
        leftover.id,
      ]);

      await service.deleteAllYoutubeData(chA, workspaceId);

      const keys = await client.query<{ thread_key: string }>(
        `SELECT thread_key FROM inbox_conversations WHERE workspace_id = $1`,
        [workspaceId],
      );
      expect(keys.rows.map((r) => r.thread_key)).toEqual([b.threadKey]);
    }));

  it.each(['an assignee and a note', 'a pending scheduled reply'] as const)(
    'wipes every copy of the deleted words from a conversation kept for %s, and archives it (C1)',
    (what) =>
      withInboxDb(async (db, client) => {
        const { workspaceId, ownerId } = await seedWorkspace(client);
        const mate = await seedMember(client, workspaceId, 'MEMBER');
        const ch = await seedChannel(client, workspaceId, 'youtube');
        const sync = new ConversationSyncService(db, rt as never);
        const service = new YoutubeDataDeletionService(
          db,
          new ConversationResyncService({ add: jest.fn() } as never, sync),
        );
        const item = await seedItem(client, {
          workspaceId,
          channelId: ch,
          platform: 'youtube',
          type: 'comment',
          platformPostId: 'vid-kept',
          text: 'kingfisherword in the comment',
          authorHandle: 'birdhandle',
          authorDisplayName: 'Birdname Person',
          authorPlatformId: 'UCbirdid',
          platformCreatedAt: T0,
          metadata: {
            post: {
              caption: 'captionword video',
              thumbnailUrl: 'https://t/thumbword.jpg',
            },
          },
        });
        const key = item.threadKey!;
        const created = await sync.syncThread(workspaceId, key);
        if (what === 'an assignee and a note') {
          await client.query(
            `UPDATE inbox_conversations SET assignee_user_id = $2, assigned_at = now()
              WHERE id = $1`,
            [created.conversationId, mate],
          );
          await client.query(
            `INSERT INTO inbox_notes (conversation_id, workspace_id, author_user_id, body)
             VALUES ($1, $2, $3, 'our own context')`,
            [created.conversationId, workspaceId, ownerId],
          );
        } else {
          await client.query(
            `INSERT INTO scheduled_inbox_messages
               (workspace_id, channel_id, type, thread_key, text, scheduled_at,
                status, inbox_conversation_id, created_by_user_id)
             VALUES ($1, $2, 'comment', $3, 'our reply', now() + interval '2 hours',
                     'pending', $4, $5)`,
            [workspaceId, ch, key, created.conversationId, ownerId],
          );
        }

        await service.deleteAllYoutubeData(ch, workspaceId);

        const r = await client.query<{
          id: string;
          archived_at: Date | null;
          unread_count: number;
          item_count: number;
          search_text: string;
          dump: string;
        }>(
          `SELECT c.id, c.archived_at, c.unread_count, c.item_count, c.search_text,
                  row_to_json(c)::text AS dump
             FROM inbox_conversations c
            WHERE c.workspace_id = $1 AND c.thread_key = $2`,
          [workspaceId, key],
        );
        // The row survives: its assignment, notes or scheduled reply are ours.
        expect(r.rows).toHaveLength(1);
        const row = r.rows[0];
        expect(row.id).toBe(created.conversationId);
        for (const word of [
          'kingfisherword',
          'birdhandle',
          'Birdname',
          'birdname',
          'UCbirdid',
          'captionword',
          'thumbword',
        ]) {
          expect(row.dump).not.toContain(word);
        }
        expect(row.search_text).toBe('');
        expect(row.unread_count).toBe(0);
        expect(row.item_count).toBe(0);
        expect(row.archived_at).not.toBeNull();

        // It left every list and count, and search finds nothing.
        const search = await client.query(
          `SELECT 1 FROM inbox_conversations
            WHERE workspace_id = $1 AND search_text LIKE '%kingfisherword%'`,
          [workspaceId],
        );
        expect(search.rows).toHaveLength(0);
        const counts = await new ConversationPresenter(db).counts(workspaceId);
        expect(counts.toReply).toBe(0);
      }),
  );
});
