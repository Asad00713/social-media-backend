import { sql } from 'drizzle-orm';
import {
  bigint,
  date,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { socialMediaChannels } from './channels.schema';
import { workspace } from './workspace.schema';

export const FIRST_WEEK_STATUSES = [
  'reading',
  'drafting',
  'ready',
  'needs_description',
  'no_tokens',
  'failed',
] as const;
export type FirstWeekStatus = (typeof FIRST_WEEK_STATUSES)[number];

export const BRAND_PROFILE_SOURCES = ['posts', 'described'] as const;
export type BrandProfileSource = (typeof BRAND_PROFILE_SOURCES)[number];

/**
 * One row per workspace: what Maestro learned (or was told) about the brand,
 * and the state of the "first week" run that drafts five posts from it.
 * Migration: drizzle/migrations/0040_home_first_week.sql (hand-written).
 */
export const workspaceBrandProfiles = pgTable('workspace_brand_profiles', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspace.id, { onDelete: 'cascade' }),
  sells: text('sells'),
  voice: text('voice')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  audience: text('audience'),
  source: text('source').$type<BrandProfileSource>().notNull(),
  // bigint: social_media_channels.id is a bigserial.
  sourceChannelId: bigint('source_channel_id', { mode: 'number' }).references(
    () => socialMediaChannels.id,
    { onDelete: 'set null' },
  ),
  sourcePlatform: text('source_platform'),
  postsRead: integer('posts_read').notNull().default(0),
  status: text('status').$type<FirstWeekStatus>().notNull(),
  draftedCount: integer('drafted_count').notNull().default(0),
  // A local calendar date (yyyy-MM-dd) in the workspace timezone.
  weekStartsOn: date('week_starts_on', { mode: 'string' }),
  weekEndsAt: timestamp('week_ends_at', { withTimezone: true }),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type BrandProfileRow = typeof workspaceBrandProfiles.$inferSelect;
export type NewBrandProfile = typeof workspaceBrandProfiles.$inferInsert;
