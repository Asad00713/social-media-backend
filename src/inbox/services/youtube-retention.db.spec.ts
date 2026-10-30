import {
  describeInboxDb,
  seedChannel,
  seedItem,
  seedWorkspace,
  withInboxDb,
} from '../testing/inbox-db';
import { ConversationSyncService } from '../conversations/services/conversation-sync.service';
import { ConversationResyncService } from '../conversations/services/conversation-resync.service';
import {
  presentRow,
  type ConversationRecord,
} from '../conversations/lib/present-row';
import { YoutubeRetentionService } from './youtube-retention.service';

const NOW = new Date('2026-10-26T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

interface ConvDbRow {
  id: string;
  kind: ConversationRecord['kind'];
  thread_key: string;
  channel_id: number;
  platform: string;
  status: ConversationRecord['status'];
  title: string | null;
  participant_name: string | null;
  participant_handle: string | null;
  participant_avatar_url: string | null;
  thumbnail_url: string | null;
  last_author_label: string | null;
  last_snippet: string | null;
  last_from_me: boolean;
  unread_count: number;
  last_message_at: Date;
  search_text: string;
  channel_username: string | null;
  channel_account_name: string;
}

const rt = {
  conversationChanged: jest.fn(),
  conversationRemoved: jest.fn(),
  countsChanged: jest.fn(),
  timelineAppended: jest.fn(),
};

describeInboxDb('YoutubeRetentionService x conversations', () => {
  it('recomputes the conversation copies of wiped comments, and leaves fresh ones alone', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'youtube');
      const sync = new ConversationSyncService(db, rt as never);
      const retention = new YoutubeRetentionService(
        db,
        new ConversationResyncService({ add: jest.fn() } as never, sync),
      );

      const old = await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'youtube',
        type: 'comment',
        platformPostId: 'vid-old',
        text: 'zebrafinch migration question',
        authorHandle: 'oldfan',
        authorDisplayName: 'Old Fan',
        authorPlatformId: 'UCold',
        platformCreatedAt: daysAgo(31),
      });
      const fresh = await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'youtube',
        type: 'comment',
        platformPostId: 'vid-new',
        text: 'kingfisher tutorial please',
        authorHandle: 'newfan',
        authorDisplayName: 'New Fan',
        authorPlatformId: 'UCnew',
        platformCreatedAt: daysAgo(29),
      });
      await sync.syncThread(workspaceId, old.threadKey!);
      await sync.syncThread(workspaceId, fresh.threadKey!);

      const before = await client.query<{ search_text: string }>(
        `SELECT search_text FROM inbox_conversations WHERE workspace_id = $1 AND thread_key = $2`,
        [workspaceId, old.threadKey],
      );
      expect(before.rows[0].search_text).toContain('zebrafinch');

      const res = await retention.wipeExpiredContent(NOW);
      expect(res.wiped).toBe(1);

      const read = async (key: string): Promise<ConvDbRow> =>
        (
          await client.query<ConvDbRow>(
            `SELECT c.*, ch.username AS channel_username, ch.account_name AS channel_account_name
               FROM inbox_conversations c
               JOIN social_media_channels ch ON ch.id = c.channel_id
              WHERE c.workspace_id = $1 AND c.thread_key = $2`,
            [workspaceId, key],
          )
        ).rows[0];

      const wiped = await read(old.threadKey!);
      expect(wiped.last_snippet).toBeNull();
      expect(wiped.last_author_label).toBeNull();
      expect(wiped.search_text).not.toContain('zebrafinch');
      expect(wiped.search_text).not.toContain('oldfan');

      const record: ConversationRecord = {
        id: wiped.id,
        kind: wiped.kind,
        threadKey: wiped.thread_key,
        channelId: wiped.channel_id,
        platform: wiped.platform,
        status: wiped.status,
        title: wiped.title,
        participantName: wiped.participant_name,
        participantHandle: wiped.participant_handle,
        participantAvatarUrl: wiped.participant_avatar_url,
        thumbnailUrl: wiped.thumbnail_url,
        lastAuthorLabel: wiped.last_author_label,
        lastSnippet: wiped.last_snippet,
        lastFromMe: wiped.last_from_me,
        unreadCount: wiped.unread_count,
        lastMessageAt: wiped.last_message_at,
        assignedAt: null,
        laterUntil: null,
        laterUntilReply: false,
        doneAt: null,
        doneVia: null,
        replyWindowClosesAt: null,
        channelUsername: wiped.channel_username,
        channelAccountName: wiped.channel_account_name,
        assignee: null,
        assignedBy: null,
        doneBy: null,
        scheduled: null,
      };
      expect(presentRow(record, NOW).contentRedacted).toBe(true);

      const kept = await read(fresh.threadKey!);
      expect(kept.last_snippet).toContain('kingfisher');
      expect(kept.search_text).toContain('kingfisher');
    }));

  it('self-heals a conversation whose items were wiped by an earlier run whose sync failed', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'youtube');
      const sync = new ConversationSyncService(db, rt as never);
      const retention = new YoutubeRetentionService(
        db,
        new ConversationResyncService({ add: jest.fn() } as never, sync),
      );
      // The item is already wiped (text and author null), so the wipe's
      // `text IS NOT NULL ...` guard never selects it again.
      const item = await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'youtube',
        type: 'comment',
        platformPostId: 'vid-w',
        text: null,
        platformCreatedAt: daysAgo(40),
      });
      await sync.syncThread(workspaceId, item.threadKey!);
      await client.query(
        `UPDATE inbox_conversations
            SET last_snippet = 'zebrafinch', last_author_label = 'oldfan',
                search_text = 'zebrafinch oldfan'
          WHERE workspace_id = $1 AND thread_key = $2`,
        [workspaceId, item.threadKey],
      );

      const res = await retention.wipeExpiredContent(NOW);
      expect(res.wiped).toBe(0);

      const after = await client.query<{
        last_snippet: string | null;
        last_author_label: string | null;
        search_text: string;
      }>(
        `SELECT last_snippet, last_author_label, search_text
           FROM inbox_conversations WHERE workspace_id = $1 AND thread_key = $2`,
        [workspaceId, item.threadKey],
      );
      expect(after.rows[0].last_snippet).toBeNull();
      expect(after.rows[0].last_author_label).toBeNull();
      expect(after.rows[0].search_text).not.toContain('zebrafinch');
    }));

  it('the stale sweep clears an emptied conversation kept for its note (C1)', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'youtube');
      const sync = new ConversationSyncService(db, rt as never);
      const retention = new YoutubeRetentionService(
        db,
        new ConversationResyncService({ add: jest.fn() } as never, sync),
      );
      const item = await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'youtube',
        type: 'comment',
        platformPostId: 'vid-gone',
        text: 'heronword',
        authorHandle: 'heronfan',
        platformCreatedAt: daysAgo(2),
      });
      const created = await sync.syncThread(workspaceId, item.threadKey!);
      await client.query(
        `INSERT INTO inbox_notes (conversation_id, workspace_id, author_user_id, body)
         VALUES ($1, $2, $3, 'ours')`,
        [created.conversationId, workspaceId, ownerId],
      );
      // An earlier deletion removed the items but left the copies behind.
      await client.query(`DELETE FROM inbox_items WHERE id = $1`, [item.id]);

      await retention.wipeExpiredContent(NOW);

      const after = await client.query<{
        last_snippet: string | null;
        last_author_label: string | null;
        search_text: string;
        archived_at: Date | null;
      }>(
        `SELECT last_snippet, last_author_label, search_text, archived_at
           FROM inbox_conversations WHERE workspace_id = $1 AND thread_key = $2`,
        [workspaceId, item.threadKey],
      );
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0].last_snippet).toBeNull();
      expect(after.rows[0].last_author_label).toBeNull();
      expect(after.rows[0].search_text).toBe('');
      expect(after.rows[0].archived_at).not.toBeNull();
    }));
});
