import {
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { socialMediaChannels } from './channels.schema';

export const AUDIENCE_STATUSES = [
  'ok',
  'below_threshold',
  'no_permission',
  'unsupported',
  'failed',
] as const;
export type AudienceStatus = (typeof AUDIENCE_STATUSES)[number];

/** One raw platform count: a country code, city, age bucket or gender key. */
export interface RawSlice {
  key: string;
  value: number;
}

/**
 * The latest audience breakdown of one channel (overwritten on each fetch, no
 * history). The jsonb columns hold raw counts; percentages and top-N are
 * computed on read. `fetchedAt` is timestamptz.
 * Migration: drizzle/migrations/0062_channel_audience.sql (hand-written).
 */
export const channelAudience = pgTable(
  'channel_audience',
  {
    channelId: integer('channel_id')
      .primaryKey()
      .references(() => socialMediaChannels.id, { onDelete: 'cascade' }),
    status: text('status').$type<AudienceStatus>().notNull(),
    /** The count the 100-follower rule was decided on; null when unknown. */
    followerCount: integer('follower_count'),
    countries: jsonb('countries').$type<RawSlice[]>().notNull().default([]),
    cities: jsonb('cities').$type<RawSlice[]>().notNull().default([]),
    ages: jsonb('ages').$type<RawSlice[]>().notNull().default([]),
    genders: jsonb('genders').$type<RawSlice[]>().notNull().default([]),
    fetchedAt: timestamp('fetched_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      'channel_audience_status_chk',
      sql`${t.status} IN ('ok', 'below_threshold', 'no_permission', 'unsupported', 'failed')`,
    ),
  ],
);

export type ChannelAudienceRow = typeof channelAudience.$inferSelect;
