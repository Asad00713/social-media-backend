import {
  pgTable,
  uuid,
  text,
  timestamp,
  varchar,
  integer,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.schema';
import { workspace } from './workspace.schema';

const tz = (name: string) => timestamp(name, { withTimezone: true });

/** inbox_saved_replies — per-workspace canned replies (migration 0049). */
export const inboxSavedReplies = pgTable(
  'inbox_saved_replies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 60 }).notNull(),
    shortcut: varchar('shortcut', { length: 32 }).notNull(),
    body: text('body').notNull(),
    usageCount: integer('usage_count').notNull().default(0),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: tz('created_at').notNull().defaultNow(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
    deletedAt: tz('deleted_at'),
  },
  (t) => ({
    shortcutUq: uniqueIndex('inbox_saved_replies_shortcut_uq')
      .on(t.workspaceId, t.shortcut)
      .where(sql`${t.deletedAt} IS NULL`),
    nameChk: check(
      'inbox_saved_replies_name_chk',
      sql`char_length(${t.name}) BETWEEN 1 AND 60`,
    ),
    shortcutChk: check(
      'inbox_saved_replies_shortcut_chk',
      sql`${t.shortcut} ~ '^[a-z0-9-]{1,32}$'`,
    ),
    bodyChk: check(
      'inbox_saved_replies_body_chk',
      sql`char_length(${t.body}) BETWEEN 1 AND 5000`,
    ),
  }),
);

export type InboxSavedReply = typeof inboxSavedReplies.$inferSelect;
export type NewInboxSavedReply = typeof inboxSavedReplies.$inferInsert;
