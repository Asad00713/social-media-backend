import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { workspace } from './workspace.schema';
import { users } from './users.schema';

/** A Telegram chat (DM, group, or supergroup) bound to a Schedura workspace.
 *  Created when a user runs `/start <workspaceId>` in a DM with @ScheduraBot,
 *  OR when a workspace admin taps the workspace selector after the bot joins
 *  a group. Used by `TelegramIngestProcessor` to route incoming messages. */
export const telegramChatBindings = pgTable(
  'telegram_chat_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    /** Telegram chat id, stored as string to avoid bigint precision issues. */
    telegramChatId: varchar('telegram_chat_id', { length: 64 }).notNull(),
    /** 'private' | 'group' | 'supergroup' — channels are not bound in Wave 1.B. */
    chatType: varchar('chat_type', { length: 16 }).notNull(),
    /** Telegram user id of the person who triggered the bind (the /start sender
     *  for DMs, or the workspace selector tapper for groups). */
    boundByTelegramUserId: varchar('bound_by_telegram_user_id', { length: 64 }),
    /** Optional Schedura user id when we can resolve the binding tapper to
     *  one of our users (today only set on DM bind because /start carries the
     *  workspaceId state; for group binds the bot doesn't know the Schedura user). */
    boundByWorkspaceUserId: uuid('bound_by_workspace_user_id').references(
      () => users.id,
      { onDelete: 'set null' },
    ),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    uniqWorkspaceChat: uniqueIndex('tg_bindings_workspace_chat_uniq').on(
      t.workspaceId,
      t.telegramChatId,
    ),
    byChatId: index('tg_bindings_chat_idx').on(t.telegramChatId),
  }),
);

export type TelegramChatBinding = typeof telegramChatBindings.$inferSelect;
export type NewTelegramChatBinding = typeof telegramChatBindings.$inferInsert;
