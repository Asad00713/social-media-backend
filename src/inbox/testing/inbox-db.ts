import type { PoolClient } from 'pg';
import {
  describeDb,
  withRollbackDb,
  type DbType,
} from '../../planner/testing/rollback-db';

/**
 * Migration files every inbox DB spec replays, in order. Later tasks append
 * their files here.
 */
export const INBOX_MIGRATIONS: string[] = [
  '0046_inbox_items_thread_key.sql',
  '0047_inbox_conversations.sql',
  '0048_inbox_notes.sql',
  '0049_inbox_saved_replies.sql',
  '0050_inbox_user_settings.sql',
  '0051_scheduled_inbox_messages_conversation.sql',
  '0052_inbox_conversations_backfill.sql',
  '0053_inbox_notification_types.sql',
];

export const describeInboxDb = describeDb;

export function withInboxDb<T>(
  fn: (db: DbType, client: PoolClient) => Promise<T>,
  extra: string[] = [],
): Promise<T> {
  return withRollbackDb([...INBOX_MIGRATIONS, ...extra], fn);
}

const rand = () => Math.random().toString(36).slice(2, 10);

export async function seedWorkspace(
  client: PoolClient,
  opts: { timezone?: string } = {},
): Promise<{ workspaceId: string; ownerId: string }> {
  const u = await client.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
    [`owner-${rand()}@example.test`, 'Owner'],
  );
  const ownerId = u.rows[0].id;
  const w = await client.query<{ id: string }>(
    `INSERT INTO workspace (name, slug, owner_id, timezone)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    ['Inbox WS', `inbox-${rand()}`, ownerId, opts.timezone ?? 'UTC'],
  );
  return { workspaceId: w.rows[0].id, ownerId };
}

export async function seedMember(
  client: PoolClient,
  workspaceId: string,
  role: 'ADMIN' | 'MEMBER' | 'GUEST',
  opts: { name?: string; email?: string } = {},
): Promise<string> {
  const email = opts.email ?? `member-${rand()}@example.test`;
  const u = await client.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
    [email, opts.name ?? `Member ${rand()}`],
  );
  const userId = u.rows[0].id;
  await client.query(
    `INSERT INTO workspace_invitations
       (workspace_id, email, user_id, role, status, invited_by, token, expires_at, accepted_at)
     VALUES ($1, $2, $3, $4::member_role, 'ACCEPTED', $3, $5,
             now() + interval '7 days', now())`,
    [workspaceId, email, userId, role, `tok-${rand()}${rand()}`],
  );
  return userId;
}

export async function seedChannel(
  client: PoolClient,
  workspaceId: string,
  platform: string,
  opts: { username?: string; accountName?: string } = {},
): Promise<number> {
  const accountId = `acct-${rand()}`;
  const r = await client.query<{ id: string }>(
    `INSERT INTO social_media_channels
       (workspace_id, platform, account_type, platform_account_id, account_name, username, access_token, connected_by_user_id)
     SELECT $1, $2, 'profile', $3, $4, $5, 'x', w.owner_id
       FROM workspace w WHERE w.id = $1 RETURNING id`,
    [
      workspaceId,
      platform,
      accountId,
      opts.accountName ?? `Account ${accountId}`,
      opts.username ?? null,
    ],
  );
  return Number(r.rows[0].id);
}

export interface SeedItemInput {
  workspaceId: string;
  channelId: number;
  platform: string;
  type: 'comment' | 'dm' | 'mention';
  platformItemId?: string;
  platformPostId?: string | null;
  platformParentId?: string | null;
  conversationId?: string | null;
  fromMe?: boolean;
  authoredByUserId?: string | null;
  status?: string;
  text?: string | null;
  authorHandle?: string | null;
  authorDisplayName?: string | null;
  authorPlatformId?: string | null;
  platformCreatedAt: Date;
  repliedAt?: Date | null;
  archivedAt?: Date | null;
  metadata?: Record<string, unknown>;
}

export async function seedItem(
  client: PoolClient,
  input: SeedItemInput,
): Promise<{ id: string; threadKey: string | null }> {
  const r = await client.query<{ id: string; thread_key: string | null }>(
    `INSERT INTO inbox_items AS i
       (workspace_id, channel_id, platform, type, platform_item_id,
        platform_post_id, platform_parent_id, conversation_id, from_me,
        authored_by_user_id, status, text, author_handle,
        author_display_name, author_platform_id, platform_created_at,
        replied_at, archived_at, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16, $17, $18, $19::jsonb)
     RETURNING i.id, to_jsonb(i)->>'thread_key' AS thread_key`,
    [
      input.workspaceId,
      input.channelId,
      input.platform,
      input.type,
      input.platformItemId ?? `item-${rand()}${rand()}`,
      input.platformPostId ?? null,
      input.platformParentId ?? null,
      input.conversationId ?? null,
      input.fromMe ?? false,
      input.authoredByUserId ?? null,
      input.status ?? 'unread',
      input.text ?? null,
      input.authorHandle ?? null,
      input.authorDisplayName ?? null,
      input.authorPlatformId ?? null,
      input.platformCreatedAt,
      input.repliedAt ?? null,
      input.archivedAt ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return { id: r.rows[0].id, threadKey: r.rows[0].thread_key };
}
