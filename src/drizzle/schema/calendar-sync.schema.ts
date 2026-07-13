import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  integer,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { workspace } from './workspace.schema';
import { socialMediaChannels } from './channels.schema';
import { posts } from './posts.schema';

// =============================================================================
// Calendar Two-Way Sync
// -----------------------------------------------------------------------------
// NOTE on id types: `social_media_channels.id` is a bigserial (numeric) pk, so
// every `channel_id` FK below is `integer` (mode: 'number'), NOT uuid. In
// contrast `workspace.id` and `posts.id` are uuid pks, so those FKs stay uuid.
// =============================================================================

// -----------------------------------------------------------------------------
// 1. calendar_post_links — links a Schedura post to the external event we wrote
//    on a connected calendar (one row per (channel, post)). Powers app→calendar
//    push + two-way write-back (echo suppression via etag/lastPushedHash).
// -----------------------------------------------------------------------------
export const calendarPostLinks = pgTable(
  'calendar_post_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    channelId: integer('channel_id')
      .notNull()
      .references(() => socialMediaChannels.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 20 }).notNull(), // 'google' | 'outlook'
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    externalEventId: varchar('external_event_id', { length: 512 }).notNull(),
    externalCalendarId: varchar('external_calendar_id', { length: 512 }),
    etag: varchar('etag', { length: 512 }), // provider etag / changeKey
    lastPushedHash: varchar('last_pushed_hash', { length: 128 }), // hash of {start,end,summary} we last wrote
    lastExternalUpdatedAt: timestamp('last_external_updated_at'),
    syncStatus: varchar('sync_status', { length: 20 })
      .notNull()
      .default('synced'), // synced | pending | error
    lastError: text('last_error'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    uqChannelPost: unique('cpl_channel_post_uq').on(t.channelId, t.postId),
    ixChannelEvent: index('cpl_channel_event_ix').on(
      t.channelId,
      t.externalEventId,
    ),
  }),
);

// -----------------------------------------------------------------------------
// 2. external_calendar_events — read-only import of the user's OTHER calendar
//    events (events WITHOUT our schedura_post_id tag), shown in the unified
//    calendar view. Kept fresh by delta pulls.
// -----------------------------------------------------------------------------
export const externalCalendarEvents = pgTable(
  'external_calendar_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    channelId: integer('channel_id')
      .notNull()
      .references(() => socialMediaChannels.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 20 }).notNull(),
    externalCalendarId: varchar('external_calendar_id', { length: 512 }),
    externalEventId: varchar('external_event_id', { length: 512 }).notNull(),
    title: text('title'),
    startsAt: timestamp('starts_at'),
    endsAt: timestamp('ends_at'),
    isAllDay: boolean('is_all_day').default(false).notNull(),
    htmlLink: text('html_link'),
    externalUpdatedAt: timestamp('external_updated_at'),
    raw: jsonb('raw'),
    fetchedAt: timestamp('fetched_at').defaultNow().notNull(),
  },
  (t) => ({
    uqChannelEvent: unique('ece_channel_event_uq').on(
      t.channelId,
      t.externalEventId,
    ),
    ixWorkspaceTime: index('ece_workspace_time_ix').on(
      t.workspaceId,
      t.startsAt,
    ),
  }),
);

// -----------------------------------------------------------------------------
// 3. calendar_sync_state — one row per connected calendar channel. Holds the
//    incremental delta cursor (Google syncToken / Graph deltaLink) + the push
//    subscription/watch ids + expiry for webhook renewal.
// -----------------------------------------------------------------------------
export const calendarSyncState = pgTable(
  'calendar_sync_state',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: integer('channel_id')
      .notNull()
      .unique()
      .references(() => socialMediaChannels.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 20 }).notNull(),
    syncToken: text('sync_token'), // Google
    deltaLink: text('delta_link'), // Outlook / Graph
    watchChannelId: varchar('watch_channel_id', { length: 255 }), // Google push channel id
    watchResourceId: varchar('watch_resource_id', { length: 512 }),
    watchExpiration: timestamp('watch_expiration'),
    subscriptionId: varchar('subscription_id', { length: 255 }), // Graph subscription id
    subscriptionExpiration: timestamp('subscription_expiration'),
    lastFullSyncAt: timestamp('last_full_sync_at'),
    lastIncrementalSyncAt: timestamp('last_incremental_sync_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    // The two columns the UNAUTHENTICATED provider webhooks look a row up by, on
    // every single notification. Without these each hit is a seq scan.
    ixWatchChannel: index('css_watch_channel_ix').on(t.watchChannelId),
    ixSubscription: index('css_subscription_ix').on(t.subscriptionId),
  }),
);

// =============================================================================
// Relations
// =============================================================================
export const calendarPostLinksRelations = relations(
  calendarPostLinks,
  ({ one }) => ({
    workspace: one(workspace, {
      fields: [calendarPostLinks.workspaceId],
      references: [workspace.id],
    }),
    channel: one(socialMediaChannels, {
      fields: [calendarPostLinks.channelId],
      references: [socialMediaChannels.id],
    }),
    post: one(posts, {
      fields: [calendarPostLinks.postId],
      references: [posts.id],
    }),
  }),
);

export const externalCalendarEventsRelations = relations(
  externalCalendarEvents,
  ({ one }) => ({
    workspace: one(workspace, {
      fields: [externalCalendarEvents.workspaceId],
      references: [workspace.id],
    }),
    channel: one(socialMediaChannels, {
      fields: [externalCalendarEvents.channelId],
      references: [socialMediaChannels.id],
    }),
  }),
);

export const calendarSyncStateRelations = relations(
  calendarSyncState,
  ({ one }) => ({
    channel: one(socialMediaChannels, {
      fields: [calendarSyncState.channelId],
      references: [socialMediaChannels.id],
    }),
  }),
);

// =============================================================================
// Inferred types
// =============================================================================
export type CalendarPostLink = typeof calendarPostLinks.$inferSelect;
export type NewCalendarPostLink = typeof calendarPostLinks.$inferInsert;
export type ExternalCalendarEvent = typeof externalCalendarEvents.$inferSelect;
export type NewExternalCalendarEvent =
  typeof externalCalendarEvents.$inferInsert;
export type CalendarSyncStateRow = typeof calendarSyncState.$inferSelect;
export type NewCalendarSyncState = typeof calendarSyncState.$inferInsert;
