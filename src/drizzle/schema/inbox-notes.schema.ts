import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.schema';
import { workspace } from './workspace.schema';
import { inboxConversations } from './inbox-conversations.schema';

/** inbox_notes — internal team notes on a conversation (migration 0048). */
export const inboxNotes = pgTable(
  'inbox_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => inboxConversations.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    authorUserId: uuid('author_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    body: text('body').notNull(),
    mentionedUserIds: uuid('mentioned_user_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    conversationIdx: index('inbox_notes_conversation_idx').on(
      t.conversationId,
      t.createdAt,
    ),
    bodyChk: check(
      'inbox_notes_body_chk',
      sql`char_length(${t.body}) BETWEEN 1 AND 5000`,
    ),
  }),
);

export type InboxNote = typeof inboxNotes.$inferSelect;
export type NewInboxNote = typeof inboxNotes.$inferInsert;
