import {
  pgTable,
  uuid,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './users.schema';
import { workspace } from './workspace.schema';

/**
 * One Maestro bridge conversation per (user, workspace). All of a user's linked
 * external numbers/channels (Telegram + WhatsApp, multiple numbers) for the same
 * workspace share this single thread — so Maestro has one continuous memory
 * regardless of which number/channel the message came from. Switching workspace
 * resolves that workspace's own thread.
 */
export const maestroBridgeThreads = pgTable(
  'maestro_bridge_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    uniqUserWorkspace: uniqueIndex('maestro_bridge_threads_user_ws_uniq').on(
      t.userId,
      t.workspaceId,
    ),
  }),
);

export type MaestroBridgeThread = typeof maestroBridgeThreads.$inferSelect;
export type NewMaestroBridgeThread = typeof maestroBridgeThreads.$inferInsert;
