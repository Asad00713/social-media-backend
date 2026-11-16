import {
  boolean,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.schema';
import { workspace } from './workspace.schema';

/**
 * A member's override of one notification switch (event x channel), per
 * workspace. A missing row means the catalogue default. `workspaceId` is NULL
 * only for account-level events; two partial unique indexes stand in for
 * NULLS NOT DISTINCT (Postgres 15+). The channel CHECK lives in the SQL only.
 * Migration: drizzle/migrations/0068_notification_preferences.sql
 * (hand-written).
 */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').references(() => workspace.id, {
      onDelete: 'cascade',
    }),
    event: varchar('event', { length: 40 }).notNull(),
    channel: varchar('channel', { length: 8 }).notNull(),
    enabled: boolean('enabled').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('notification_preferences_ws_uq')
      .on(t.userId, t.workspaceId, t.event, t.channel)
      .where(sql`${t.workspaceId} is not null`),
    uniqueIndex('notification_preferences_account_uq')
      .on(t.userId, t.event, t.channel)
      .where(sql`${t.workspaceId} is null`),
    index('notification_preferences_user_idx').on(t.userId),
  ],
);

export type NotificationPreferenceRow =
  typeof notificationPreferences.$inferSelect;
