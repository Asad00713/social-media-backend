import {
  pgTable,
  serial,
  bigint,
  integer,
  date,
  timestamp,
  numeric,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { socialMediaChannels } from './channels.schema';

export const channelAnalyticsDaily = pgTable(
  'channel_analytics_daily',
  {
    id: serial('id').primaryKey(),
    channelId: bigint('channel_id', { mode: 'number' })
      .notNull()
      .references(() => socialMediaChannels.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    postsPublished: integer('posts_published').default(0).notNull(),
    totalLikes: integer('total_likes').default(0).notNull(),
    totalComments: integer('total_comments').default(0).notNull(),
    totalShares: integer('total_shares').default(0).notNull(),
    totalImpressions: integer('total_impressions'),
    totalReach: integer('total_reach'),
    followersAtEndOfDay: integer('followers_at_end_of_day'),
    followersGained: integer('followers_gained'),
    engagementRate: numeric('engagement_rate', { precision: 5, scale: 2 }),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    channelDateUnique: unique('channel_analytics_daily_channel_date_unique').on(
      t.channelId,
      t.date,
    ),
    channelDateIdx: index('channel_analytics_daily_channel_date_idx').on(
      t.channelId,
      t.date.desc(),
    ),
  }),
);

export type ChannelAnalyticsDaily = typeof channelAnalyticsDaily.$inferSelect;
export type NewChannelAnalyticsDaily =
  typeof channelAnalyticsDaily.$inferInsert;
