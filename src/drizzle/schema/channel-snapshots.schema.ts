import {
  pgTable,
  serial,
  integer,
  bigint,
  date,
  jsonb,
  timestamp,
  text,
  varchar,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { socialMediaChannels } from './channels.schema';

export const SYNC_STATUSES = ['success', 'partial', 'failed'] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

export const channelSnapshots = pgTable(
  'channel_snapshots',
  {
    id: serial('id').primaryKey(),
    channelId: bigint('channel_id', { mode: 'number' })
      .notNull()
      .references(() => socialMediaChannels.id, { onDelete: 'cascade' }),
    snapshotDate: date('snapshot_date').notNull(),
    followersCount: integer('followers_count'),
    followingCount: integer('following_count'),
    totalPostsCount: integer('total_posts_count'),
    platformMetrics: jsonb('platform_metrics').default({}).notNull(),
    metricsSchemaVersion: integer('metrics_schema_version').default(1).notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    syncStatus: varchar('sync_status', { length: 16 }).notNull().$type<SyncStatus>(),
    syncError: text('sync_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    channelDateUnique: unique('channel_snapshots_channel_date_unique').on(t.channelId, t.snapshotDate),
    channelDateIdx: index('channel_snapshots_channel_date_idx').on(t.channelId, t.snapshotDate.desc()),
  }),
);

export type ChannelSnapshot = typeof channelSnapshots.$inferSelect;
export type NewChannelSnapshot = typeof channelSnapshots.$inferInsert;
