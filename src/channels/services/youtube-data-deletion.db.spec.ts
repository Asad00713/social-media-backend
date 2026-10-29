import {
  describeInboxDb,
  seedChannel,
  seedItem,
  seedWorkspace,
  withInboxDb,
} from '../../inbox/testing/inbox-db';
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
});
