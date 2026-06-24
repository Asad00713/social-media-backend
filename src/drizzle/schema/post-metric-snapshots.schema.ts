import {
  pgTable,
  serial,
  bigint,
  uuid,
  timestamp,
  varchar,
  jsonb,
  integer,
  index,
} from 'drizzle-orm/pg-core';
import { socialMediaChannels } from './channels.schema';
import { posts } from './posts.schema';
import { SYNC_STATUSES, type SyncStatus } from './channel-snapshots.schema';

export const AGE_BUCKETS = [
  '30m',
  '1h',
  '6h',
  '24h',
  '3d',
  '7d',
  '30d',
  'final',
] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

export const postMetricSnapshots = pgTable(
  'post_metric_snapshots',
  {
    id: serial('id').primaryKey(),
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    channelId: bigint('channel_id', { mode: 'number' })
      .notNull()
      .references(() => socialMediaChannels.id, { onDelete: 'cascade' }),
    snapshotAt: timestamp('snapshot_at', { withTimezone: true }).notNull(),
    ageBucket: varchar('age_bucket', { length: 16 })
      .notNull()
      .$type<AgeBucket>(),
    likesCount: integer('likes_count'),
    commentsCount: integer('comments_count'),
    sharesCount: integer('shares_count'),
    impressionsCount: integer('impressions_count'),
    reachCount: integer('reach_count'),
    platformMetrics: jsonb('platform_metrics').default({}).notNull(),
    metricsSchemaVersion: integer('metrics_schema_version')
      .default(1)
      .notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    syncStatus: varchar('sync_status', { length: 16 })
      .notNull()
      .$type<SyncStatus>(),
  },
  (t) => ({
    postSnapshotIdx: index('post_metric_snapshots_post_snapshot_idx').on(
      t.postId,
      t.snapshotAt.desc(),
    ),
    channelSnapshotIdx: index('post_metric_snapshots_channel_snapshot_idx').on(
      t.channelId,
      t.snapshotAt.desc(),
    ),
  }),
);

export type PostMetricSnapshot = typeof postMetricSnapshots.$inferSelect;
export type NewPostMetricSnapshot = typeof postMetricSnapshots.$inferInsert;
