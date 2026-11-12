import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.schema';
import { workspace } from './workspace.schema';

/** Longest network name, in characters. Mirrored by a CHECK in the migration. */
export const NETWORK_REQUEST_NAME_MAX = 60;
/** Longest note, in characters. Mirrored by a CHECK in the migration. */
export const NETWORK_REQUEST_NOTE_MAX = 500;

/**
 * A "Request a network" submission from the Channels page: a platform we do
 * not support yet, as the person typed it.
 * Migration: drizzle/migrations/0063_channel_pause_and_network_requests.sql
 * (hand-written; the length CHECKs live there).
 */
export const networkRequests = pgTable(
  'network_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    network: text('network').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('network_requests_user_id_created_at_idx').on(t.userId, t.createdAt),
    index('network_requests_workspace_id_created_at_idx').on(
      t.workspaceId,
      t.createdAt,
    ),
  ],
);

export type NetworkRequestRow = typeof networkRequests.$inferSelect;
