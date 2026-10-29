// One test per ingest path family (R1): the REAL caller, with its external
// services faked, reaches the REAL InboxService upsert and ends in a
// conversation row for the right workspace and thread.
const mockHolder: { db: any } = { db: null };
jest.mock('../drizzle/db', () => ({
  db: new Proxy(
    {},
    {
      get: (_t, prop) => mockHolder.db[prop as string],
    },
  ),
}));

import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { DbType } from '../drizzle/db';
import {
  describeInboxDb,
  seedChannel,
  seedWorkspace,
  withInboxDb,
} from './testing/inbox-db';
import { InboxService } from './inbox.service';
import { ConversationSyncService } from './conversations/services/conversation-sync.service';
import { WebhooksController } from '../channels/webhooks.controller';
import { InboxPollProcessor } from './processors/inbox-poll.processor';
import { SlackIngestProcessor } from './processors/slack-ingest.processor';
import { TelegramIngestProcessor } from './processors/telegram-ingest.processor';
import { DiscordIngestProcessor } from './processors/discord-ingest.processor';

function buildInbox(db: DbType) {
  mockHolder.db = db;
  const rt = {
    conversationChanged: jest.fn(),
    conversationRemoved: jest.fn(),
    countsChanged: jest.fn(),
    timelineAppended: jest.fn(),
  };
  const sync = new ConversationSyncService(db, rt as never);
  const inbox = new InboxService(
    { emit: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    rt as never,
    sync,
    { enqueue: jest.fn(), syncOrEnqueue: jest.fn() } as never,
  );
  return { inbox, rt };
}

async function expectConversation(
  client: PoolClient,
  workspaceId: string,
  threadKey: string,
  itemPlatformId: string,
) {
  const item = await client.query<{ thread_key: string }>(
    `SELECT thread_key FROM inbox_items WHERE workspace_id = $1 AND platform_item_id = $2`,
    [workspaceId, itemPlatformId],
  );
  expect(item.rows).toHaveLength(1);
  expect(item.rows[0].thread_key).toBe(threadKey);
  const conv = await client.query(
    `SELECT id FROM inbox_conversations WHERE workspace_id = $1 AND thread_key = $2`,
    [workspaceId, threadKey],
  );
  expect(conv.rows).toHaveLength(1);
}

async function seedPublishedPost(
  client: PoolClient,
  workspaceId: string,
  ownerId: string,
  channelId: number,
  platformPostId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO posts (workspace_id, created_by_id, targets, status, published_at, content, created_at)
     VALUES ($1, $2, $3::jsonb, 'published', now(), 'caption', now())`,
    [
      workspaceId,
      ownerId,
      JSON.stringify([{ channelId: String(channelId), platformPostId }]),
    ],
  );
}

const logger = new Logger('ingest-paths-spec');

describeInboxDb('ingest path families end in a conversation (R1)', () => {
  it('webhook: a comment event is upserted and synced', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'threads');
      await seedPublishedPost(client, workspaceId, ownerId, ch, 'p1');
      const acct = (
        await client.query<{ platform_account_id: string }>(
          `SELECT platform_account_id FROM social_media_channels WHERE id = $1`,
          [ch],
        )
      ).rows[0].platform_account_id;
      const { inbox } = buildInbox(db);
      const controller: any = Object.create(WebhooksController.prototype);
      controller.inbox = inbox;
      controller.logger = logger;

      await controller.ingestFromWebhook({
        platform: 'threads',
        platformAccountIdToMatch: acct,
        platformItemId: 'wc1',
        platformParentId: null,
        platformPostId: 'p1',
        authorPlatformId: 'a1',
        authorHandle: 'ana',
        authorDisplayName: 'Ana',
        text: 'hello from a webhook',
        eventTime: new Date(),
      });

      await expectConversation(client, workspaceId, `${ch}:p1`, 'wc1');
    }));

  it.each(['threads', 'bluesky', 'mastodon'] as const)(
    'poll (%s): fetched comments, mentions and dms are upserted and synced',
    (platform) =>
      withInboxDb(async (db, client) => {
        const { workspaceId, ownerId } = await seedWorkspace(client);
        const ch = await seedChannel(client, workspaceId, platform);
        await seedPublishedPost(client, workspaceId, ownerId, ch, 'p1');
        const { inbox } = buildInbox(db);
        const adapter = {
          fetchComments: jest.fn().mockResolvedValue([
            {
              platformItemId: 'pc1',
              platformParentId: null,
              authorHandle: 'ana',
              authorDisplayName: 'Ana',
              text: 'polled comment',
              fromMe: false,
              platformCreatedAt: new Date(),
              metadata: {},
            },
          ]),
          fetchMentions: jest.fn().mockResolvedValue([
            {
              platformItemId: 'pm1',
              platformParentId: null,
              authorHandle: 'bo',
              authorDisplayName: 'Bo',
              text: 'polled mention',
              fromMe: false,
              platformCreatedAt: new Date(),
              metadata: {},
            },
          ]),
        };
        const proc: any = Object.create(InboxPollProcessor.prototype);
        proc.logger = logger;
        proc.webhookSubscribedChannels = new Set<number>();
        proc.channelService = {
          getAccessToken: jest.fn().mockResolvedValue('t'),
        };
        const hasDm = platform !== 'threads';
        proc.dispatcher = {
          supports: () => true,
          get: () => adapter,
          supportsDm: () => hasDm,
          getDm: () => ({
            listConversations: jest.fn().mockResolvedValue([
              {
                conversationId: 'cv1',
                participant: { platformId: 'pp', handle: 'pat' },
              },
            ]),
            fetchConversationMessages: jest.fn().mockResolvedValue([
              {
                platformItemId: 'pd1',
                conversationId: 'cv1',
                platformParentId: null,
                author: { platformId: 'pp' },
                text: 'polled dm',
                fromMe: false,
                platformCreatedAt: new Date(),
                metadata: {},
              },
            ]),
          }),
        };
        proc.inboxService = inbox;

        await proc.process({ name: 'poll', data: { channelId: ch } });

        await expectConversation(client, workspaceId, `${ch}:p1`, 'pc1');
        await expectConversation(
          client,
          workspaceId,
          `${ch}:mention:pm1`,
          'pm1',
        );
        if (hasDm) {
          await expectConversation(client, workspaceId, `${ch}:cv1`, 'pd1');
        }
      }),
  );

  it('Slack: a message event is upserted and synced', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'slack');
      const { inbox } = buildInbox(db);
      const proc: any = Object.create(SlackIngestProcessor.prototype);
      proc.logger = logger;
      proc.inbox = inbox;
      proc.channelService = {
        getAccessToken: jest.fn().mockResolvedValue('t'),
      };
      proc.slack = {
        getUserInfo: jest.fn().mockResolvedValue(null),
        resolveSlackMentions: jest.fn(async (_t: string, text: string) => text),
      };
      proc.r2 = {};

      await proc.ingestForChannel(
        { id: ch, workspaceId },
        {
          type: 'message',
          channel: 'D42',
          ts: '1700000000.0001',
          user: 'U1',
          text: 'hi from slack',
        },
      );

      await expectConversation(
        client,
        workspaceId,
        `${ch}:D42`,
        '1700000000.0001',
      );
    }));

  it('Telegram: a plain message is upserted and synced', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'telegram');
      const { inbox } = buildInbox(db);
      const proc: any = Object.create(TelegramIngestProcessor.prototype);
      proc.logger = logger;
      proc.inbox = inbox;
      proc.r2 = {};
      const tg = { resolveEntities: (text: string) => text };

      await proc.ingestPlainMessage(tg, { id: ch }, workspaceId, {
        message_id: 77,
        date: Math.floor(Date.now() / 1000),
        text: 'hi from telegram',
        chat: { id: 555, type: 'private' },
      });

      await expectConversation(client, workspaceId, `${ch}:555`, '77');
    }));

  it('Discord: a create event is upserted and synced', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'discord');
      const { inbox } = buildInbox(db);
      const proc: any = Object.create(DiscordIngestProcessor.prototype);
      proc.logger = logger;
      proc.inbox = inbox;
      proc.discord = { avatarUrl: () => null };
      proc.r2 = {};

      await proc.ingestForChannel({ id: ch, workspaceId }, 'create', {
        id: 'dm-1',
        channel_id: 'dc-9',
        guild_id: 'g1',
        content: 'hi from discord',
        timestamp: new Date().toISOString(),
        author: { id: 'u1', username: 'ana' },
      });

      await expectConversation(client, workspaceId, `${ch}:dc-9`, 'dm-1');
    }));
});
