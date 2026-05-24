import {
  pgTable,
  bigint,
  integer,
  timestamp,
  text,
  varchar,
} from 'drizzle-orm/pg-core';
import { socialMediaChannels } from './channels.schema';

export const PROFILE_SYNC_STATUSES = ['success', 'failed', 'rate_limited'] as const;
export type ProfileSyncStatus = (typeof PROFILE_SYNC_STATUSES)[number];

export const BACKFILL_STATUSES = ['pending', 'running', 'completed', 'failed'] as const;
export type BackfillStatus = (typeof BACKFILL_STATUSES)[number];

export const channelSyncState = pgTable('channel_sync_state', {
  channelId: bigint('channel_id', { mode: 'number' })
    .primaryKey()
    .references(() => socialMediaChannels.id, { onDelete: 'cascade' }),
  lastProfileSyncAt: timestamp('last_profile_sync_at', { withTimezone: true }),
  lastProfileSyncStatus: varchar('last_profile_sync_status', { length: 20 }).$type<ProfileSyncStatus>(),
  lastProfileSyncError: text('last_profile_sync_error'),
  nextProfileSyncAt: timestamp('next_profile_sync_at', { withTimezone: true }).notNull(),
  consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
  pausedUntil: timestamp('paused_until', { withTimezone: true }),
  initialBackfillStatus: varchar('initial_backfill_status', { length: 20 })
    .default('pending')
    .notNull()
    .$type<BackfillStatus>(),
  initialBackfillCompletedAt: timestamp('initial_backfill_completed_at', { withTimezone: true }),
  lastPostsSyncAt: timestamp('last_posts_sync_at', { withTimezone: true }),
  pubsubhubbubLeaseExpiresAt: timestamp('pubsubhubbub_lease_expires_at', { withTimezone: true }),
});

export type ChannelSyncStateRow = typeof channelSyncState.$inferSelect;
export type NewChannelSyncState = typeof channelSyncState.$inferInsert;
