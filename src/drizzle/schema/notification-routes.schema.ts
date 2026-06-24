import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { workspace } from './workspace.schema';
import { socialMediaChannels } from './channels.schema';

/** Outbound notification routing rule.
 *  When a Schedura event of type `eventType` fires in `workspaceId`, send a
 *  message via `channelId` (the social_media_channels row of the destination
 *  platform) to `targetPlatformChannelId` (the platform-side channel/chat id).
 */
export const notificationRoutes = pgTable(
  'notification_routes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    channelId: integer('channel_id')
      .notNull()
      .references(() => socialMediaChannels.id, { onDelete: 'cascade' }),
    targetPlatformChannelId: varchar('target_platform_channel_id', {
      length: 128,
    }).notNull(),
    targetDisplayName: varchar('target_display_name', { length: 256 }),
    enabled: boolean('enabled').notNull().default(true),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index('notification_routes_workspace_idx').on(t.workspaceId),
    byEvent: index('notification_routes_event_idx').on(
      t.workspaceId,
      t.eventType,
    ),
  }),
);

export type NotificationRoute = typeof notificationRoutes.$inferSelect;
export type NewNotificationRoute = typeof notificationRoutes.$inferInsert;
