import {
  pgTable,
  uuid,
  text,
  timestamp,
  varchar,
  integer,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users.schema';
import { workspace } from './workspace.schema';
import { socialMediaChannels } from './channels.schema';
import { inboxItems } from './inbox.schema';

export const SCHEDULED_INBOX_TYPES = ['comment', 'dm'] as const;
export type ScheduledInboxType = (typeof SCHEDULED_INBOX_TYPES)[number];

export const SCHEDULED_INBOX_STATUSES = [
  'pending',
  'sending',
  'sent',
  'failed',
  'cancelled',
] as const;
export type ScheduledInboxStatus = (typeof SCHEDULED_INBOX_STATUSES)[number];

/**
 * scheduled_inbox_messages — comment-replies or DMs queued to fire in the future.
 *
 * Source of truth for the UI's "Scheduled" view (list / edit / cancel).
 * Execution is paired with a BullMQ delayed job (queue: SCHEDULED_INBOX);
 * `queueJobId` links the two. Cancel = remove BullMQ job + mark row cancelled.
 *
 * threadKey shape varies by type:
 *   - 'dm':                    `<channelId>:<conversationId>`
 *   - 'comment' (top-level):   `<channelId>:<platformPostId>`
 *   - 'comment' (nested reply): parent inbox_items.id  (uuid string)
 *
 * After fire, `sentInboxItemId` points at the real inbox row produced by
 * sendDm / reply / commentOnPost.
 */
export const scheduledInboxMessages = pgTable(
  'scheduled_inbox_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),

    channelId: integer('channel_id')
      .notNull()
      .references(() => socialMediaChannels.id, { onDelete: 'cascade' }),

    type: varchar('type', { length: 10 }).$type<ScheduledInboxType>().notNull(),

    threadKey: varchar('thread_key', { length: 255 }).notNull(),

    // For nested comment replies — the parent comment we're replying to.
    parentItemId: uuid('parent_item_id').references(() => inboxItems.id, {
      onDelete: 'set null',
    }),

    // For top-level comments on a post.
    platformPostId: varchar('platform_post_id', { length: 255 }),

    // For DMs.
    conversationId: varchar('conversation_id', { length: 255 }),

    // Short human-readable label for list previews (e.g. "@alex" or "Post · @bob").
    targetLabel: text('target_label'),

    text: text('text').notNull(),

    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    timezone: varchar('timezone', { length: 64 }),

    status: varchar('status', { length: 20 })
      .$type<ScheduledInboxStatus>()
      .default('pending')
      .notNull(),

    queueJobId: varchar('queue_job_id', { length: 255 }),

    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    sentInboxItemId: uuid('sent_inbox_item_id').references(
      () => inboxItems.id,
      {
        onDelete: 'set null',
      },
    ),

    errorMessage: text('error_message'),
    attempts: integer('attempts').default(0).notNull(),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    workspaceStatusIdx: index('scheduled_inbox_workspace_status_idx').on(
      table.workspaceId,
      table.status,
    ),
    channelStatusIdx: index('scheduled_inbox_channel_status_idx').on(
      table.channelId,
      table.status,
    ),
    scheduledAtIdx: index('scheduled_inbox_scheduled_at_idx').on(
      table.scheduledAt,
    ),
    threadKeyIdx: index('scheduled_inbox_thread_key_idx').on(
      table.workspaceId,
      table.threadKey,
      table.status,
    ),
  }),
);

export const scheduledInboxMessagesRelations = relations(
  scheduledInboxMessages,
  ({ one }) => ({
    workspace: one(workspace, {
      fields: [scheduledInboxMessages.workspaceId],
      references: [workspace.id],
    }),
    channel: one(socialMediaChannels, {
      fields: [scheduledInboxMessages.channelId],
      references: [socialMediaChannels.id],
    }),
    parentItem: one(inboxItems, {
      fields: [scheduledInboxMessages.parentItemId],
      references: [inboxItems.id],
      relationName: 'scheduledParent',
    }),
    sentInboxItem: one(inboxItems, {
      fields: [scheduledInboxMessages.sentInboxItemId],
      references: [inboxItems.id],
      relationName: 'scheduledSent',
    }),
    createdByUser: one(users, {
      fields: [scheduledInboxMessages.createdByUserId],
      references: [users.id],
    }),
  }),
);

export type ScheduledInboxMessage = typeof scheduledInboxMessages.$inferSelect;
export type NewScheduledInboxMessage =
  typeof scheduledInboxMessages.$inferInsert;
