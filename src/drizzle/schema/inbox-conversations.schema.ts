import {
  pgTable,
  uuid,
  text,
  timestamp,
  varchar,
  boolean,
  integer,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.schema';
import { workspace } from './workspace.schema';
import { socialMediaChannels, SupportedPlatform } from './channels.schema';
import { posts } from './posts.schema';

export const INBOX_CONVERSATION_KINDS = [
  'comment_thread',
  'dm',
  'mention',
] as const;
export type InboxConversationKind = (typeof INBOX_CONVERSATION_KINDS)[number];

export const INBOX_CONVERSATION_STATUSES = [
  'to_reply',
  'later',
  'done',
] as const;
export type InboxConversationStatus =
  (typeof INBOX_CONVERSATION_STATUSES)[number];

export const INBOX_CONVERSATION_DONE_VIA = [
  'reply',
  'manual',
  'platform',
] as const;
export type InboxConversationDoneVia =
  (typeof INBOX_CONVERSATION_DONE_VIA)[number];

const tz = (name: string) => timestamp(name, { withTimezone: true });

/**
 * inbox_conversations — one row per inbox thread (migration 0047), keyed by
 * (workspace_id, thread_key) where thread_key is inbox_items.thread_key.
 */
export const inboxConversations = pgTable(
  'inbox_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    channelId: integer('channel_id')
      .notNull()
      .references(() => socialMediaChannels.id, { onDelete: 'cascade' }),
    platform: varchar('platform', { length: 20 })
      .$type<SupportedPlatform>()
      .notNull(),
    kind: varchar('kind', { length: 16 })
      .$type<InboxConversationKind>()
      .notNull(),
    threadKey: text('thread_key').notNull(),
    status: varchar('status', { length: 10 })
      .$type<InboxConversationStatus>()
      .notNull()
      .default('to_reply'),
    laterUntil: tz('later_until'),
    laterUntilReply: boolean('later_until_reply').notNull().default(false),
    assigneeUserId: uuid('assignee_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    assignedByUserId: uuid('assigned_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    doneByUserId: uuid('done_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    assignedAt: tz('assigned_at'),
    doneAt: tz('done_at'),
    doneVia: varchar('done_via', {
      length: 10,
    }).$type<InboxConversationDoneVia>(),
    unreadCount: integer('unread_count').notNull().default(0),
    itemCount: integer('item_count').notNull().default(0),
    lastMessageAt: tz('last_message_at').notNull(),
    lastInboundAt: tz('last_inbound_at'),
    lastOutboundAt: tz('last_outbound_at'),
    lastSnippet: text('last_snippet'),
    lastAuthorLabel: text('last_author_label'),
    lastFromMe: boolean('last_from_me').notNull().default(false),
    replyWindowClosesAt: tz('reply_window_closes_at'),
    postId: uuid('post_id').references(() => posts.id, {
      onDelete: 'set null',
    }),
    title: text('title'),
    thumbnailUrl: text('thumbnail_url'),
    participantHandle: text('participant_handle'),
    participantName: text('participant_name'),
    participantAvatarUrl: text('participant_avatar_url'),
    participantPlatformId: text('participant_platform_id'),
    searchText: text('search_text').notNull().default(''),
    archivedAt: tz('archived_at'),
    createdAt: tz('created_at').notNull().defaultNow(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    wsKeyUq: uniqueIndex('inbox_conversations_ws_key_uq').on(
      t.workspaceId,
      t.threadKey,
    ),
    viewIdx: index('inbox_conversations_view_idx')
      .on(t.workspaceId, t.status, t.lastMessageAt.desc(), t.id.desc())
      .where(sql`${t.archivedAt} IS NULL`),
    assigneeIdx: index('inbox_conversations_assignee_idx').on(
      t.workspaceId,
      t.assigneeUserId,
    ),
    laterIdx: index('inbox_conversations_later_idx')
      .on(t.laterUntil)
      .where(sql`${t.status} = 'later'`),
    kindIdx: index('inbox_conversations_kind_idx').on(t.workspaceId, t.kind),
    searchTrgmIdx: index('inbox_conversations_search_trgm_idx').using(
      'gin',
      t.searchText.op('gin_trgm_ops'),
    ),
    kindChk: check(
      'inbox_conversations_kind_chk',
      sql`${t.kind} IN ('comment_thread', 'dm', 'mention')`,
    ),
    statusChk: check(
      'inbox_conversations_status_chk',
      sql`${t.status} IN ('to_reply', 'later', 'done')`,
    ),
    doneViaChk: check(
      'inbox_conversations_done_via_chk',
      sql`${t.doneVia} IS NULL OR ${t.doneVia} IN ('reply', 'manual', 'platform')`,
    ),
    laterChk: check(
      'inbox_conversations_later_chk',
      sql`${t.status} <> 'later' OR ${t.laterUntil} IS NOT NULL OR ${t.laterUntilReply}`,
    ),
  }),
);

export type InboxConversation = typeof inboxConversations.$inferSelect;
export type NewInboxConversation = typeof inboxConversations.$inferInsert;
