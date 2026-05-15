import {
  pgTable,
  pgEnum,
  uuid,
  timestamp,
  text,
  varchar,
  jsonb,
  integer,
  boolean,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users.schema';
import { workspace } from './workspace.schema';

// Message role enum
export const MESSAGE_ROLES = ['user', 'assistant', 'system', 'tool'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];
export const messageRoleEnum = pgEnum('message_role', MESSAGE_ROLES);

/**
 * Conversations table - stores chat sessions between user and AI assistant
 */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),

    title: varchar('title', { length: 255 }),

    isPinned: boolean('is_pinned').default(false).notNull(),

    // Sharing — when true, all workspace members can read this conversation
    sharedWithWorkspace: boolean('shared_with_workspace').default(false).notNull(),
    sharedAt: timestamp('shared_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('conversations_user_id_idx').on(table.userId),
    index('conversations_workspace_id_idx').on(table.workspaceId),
    index('conversations_created_at_idx').on(table.createdAt),
    index('conversations_shared_idx').on(table.workspaceId, table.sharedWithWorkspace),
  ],
);

/**
 * Chat messages table - stores individual messages in a conversation
 */
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),

    role: messageRoleEnum('role').notNull(),
    content: text('content'),

    // Reply-to: references another message in the same conversation
    replyToId: uuid('reply_to_id'),

    // Metadata for tool calls, thinking steps, follow-ups, UI actions, and media
    metadata: jsonb('metadata').$type<{
      toolCalls?: Array<{
        id: string;
        name: string;
        arguments: Record<string, any>;
      }>;
      toolCallId?: string;
      toolName?: string;
      thinkingSteps?: string[];
      followups?: string[];
      actions?: Array<{
        type: string;
        payload: Record<string, any>;
      }>;
      media?: Array<{
        id: string;
        url: string;
        thumbnailUrl?: string;
        alt?: string;
        width?: number;
        height?: number;
        photographer?: string;
        source: string;
        mimeType?: string;
        duration?: number;
      }>;
      regenerated?: boolean;
    }>(),

    // User feedback on assistant messages (thumbs up/down)
    feedback: varchar('feedback', { length: 10 }).$type<'good' | 'bad'>(),
    feedbackComment: text('feedback_comment'),

    modelUsed: varchar('model_used', { length: 100 }),
    tokenCount: integer('token_count'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('chat_messages_conversation_id_idx').on(table.conversationId),
    index('chat_messages_created_at_idx').on(table.createdAt),
  ],
);

// Relations
export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  user: one(users, {
    fields: [conversations.userId],
    references: [users.id],
  }),
  workspace: one(workspace, {
    fields: [conversations.workspaceId],
    references: [workspace.id],
  }),
  messages: many(chatMessages),
}));

export const chatMessagesRelations = relations(chatMessages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [chatMessages.conversationId],
    references: [conversations.id],
  }),
  replyTo: one(chatMessages, {
    fields: [chatMessages.replyToId],
    references: [chatMessages.id],
    relationName: 'messageReplies',
  }),
}));

// Type exports
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;
