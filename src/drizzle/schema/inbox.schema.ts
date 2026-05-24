import {
  pgTable,
  uuid,
  text,
  timestamp,
  varchar,
  boolean,
  jsonb,
  index,
  integer,
  unique,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users.schema';
import { workspace } from './workspace.schema';
import { socialMediaChannels, SupportedPlatform } from './channels.schema';
import { posts } from './posts.schema';

// type — Phase 1 only stores 'comment'. 'dm' reserved for Phase 2 so we don't
// need a schema migration later.
export const INBOX_ITEM_TYPES = ['comment', 'dm'] as const;
export type InboxItemType = (typeof INBOX_ITEM_TYPES)[number];

export const INBOX_ITEM_STATUSES = [
  'unread',
  'needs_reply',
  'replied',
  'done',
] as const;
export type InboxItemStatus = (typeof INBOX_ITEM_STATUSES)[number];

/**
 * inbox_items — every comment / reply / (later) DM we've ingested.
 *
 * Each row is one comment, including our own replies (fromMe=true).
 * Threading is reconstructed by walking platformParentId pointers — root
 * comments have platformParentId = null.
 */
export const inboxItems = pgTable(
  'inbox_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),

    channelId: integer('channel_id')
      .notNull()
      .references(() => socialMediaChannels.id, { onDelete: 'cascade' }),

    platform: varchar('platform', { length: 20 }).$type<SupportedPlatform>().notNull(),
    type: varchar('type', { length: 10 }).$type<InboxItemType>().notNull(),

    // Platform-side identifiers
    platformItemId: varchar('platform_item_id', { length: 255 }).notNull(),
    platformParentId: varchar('platform_parent_id', { length: 255 }),
    // Platform id of the post this comment belongs to (FB/IG/YT post/video id).
    // Always populated for comments; for DMs (Phase 2) will be null.
    platformPostId: varchar('platform_post_id', { length: 255 }),

    // If this comment is on a post we published through Schedura, link it.
    ourPostId: uuid('our_post_id').references(() => posts.id, { onDelete: 'set null' }),

    // Author info (the person who left the comment)
    authorPlatformId: varchar('author_platform_id', { length: 255 }),
    authorHandle: varchar('author_handle', { length: 255 }),
    authorDisplayName: varchar('author_display_name', { length: 255 }),
    authorAvatarUrl: text('author_avatar_url'),

    text: text('text'),

    status: varchar('status', { length: 20 })
      .$type<InboxItemStatus>()
      .default('unread')
      .notNull(),

    // True when authored by our connected account (e.g. our reply via Schedura,
    // or a manual reply we made on the platform itself).
    fromMe: boolean('from_me').default(false).notNull(),

    // Time the comment was created on the platform.
    platformCreatedAt: timestamp('platform_created_at', { withTimezone: true }).notNull(),
    // Time we first ingested it.
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),

    // If a user replied to this from Schedura, track who + when.
    repliedByUserId: uuid('replied_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    repliedAt: timestamp('replied_at', { withTimezone: true }),

    // Platform-specific extras: attachment urls, sentiment from API, like counts, etc.
    metadata: jsonb('metadata').$type<Record<string, any>>().default({}),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    workspaceIdx: index('inbox_workspace_idx').on(table.workspaceId),
    workspaceStatusIdx: index('inbox_workspace_status_idx').on(
      table.workspaceId,
      table.status,
    ),
    channelIdx: index('inbox_channel_idx').on(table.channelId),
    postIdx: index('inbox_post_idx').on(table.channelId, table.platformPostId),
    parentIdx: index('inbox_parent_idx').on(table.platformParentId),
    platformCreatedIdx: index('inbox_platform_created_idx').on(
      table.platformCreatedAt,
    ),
    // Prevent dup ingestion across webhook + polling
    uniquePerChannel: unique('unique_inbox_item_per_channel').on(
      table.channelId,
      table.platformItemId,
    ),
  }),
);

export const inboxItemsRelations = relations(inboxItems, ({ one }) => ({
  workspace: one(workspace, {
    fields: [inboxItems.workspaceId],
    references: [workspace.id],
  }),
  channel: one(socialMediaChannels, {
    fields: [inboxItems.channelId],
    references: [socialMediaChannels.id],
  }),
  ourPost: one(posts, {
    fields: [inboxItems.ourPostId],
    references: [posts.id],
  }),
  repliedByUser: one(users, {
    fields: [inboxItems.repliedByUserId],
    references: [users.id],
  }),
}));

export type InboxItem = typeof inboxItems.$inferSelect;
export type NewInboxItem = typeof inboxItems.$inferInsert;
