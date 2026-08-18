import {
  pgTable,
  uuid,
  text,
  timestamp,
  varchar,
  boolean,
  jsonb,
  integer,
  real,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { campaigns, CampaignSlotStatus, ChannelDayContentJson } from './campaigns.schema';

export const EVERGREEN_POST_STATUSES = ['active', 'paused', 'retired'] as const;
export type EvergreenPostStatus = (typeof EVERGREEN_POST_STATUSES)[number];

export interface EvergreenCategoryScheduleJson {
  weekdays: number[]; // 0=Sun..6=Sat
  times: string[];    // HH:mm
}
export interface EvergreenSeasonalJson {
  startDate: string; // yyyy-MM-dd
  endDate: string;
}
export interface EvergreenVariationJson {
  id: string;
  caption: string;
  media?: { id: string; filename: string; kind: 'image' | 'video'; url?: string }[];
  source: 'ai' | 'manual';
}
export interface RecyclePolicyJson {
  mode: 'forever' | 'maxCount' | 'expiry';
  maxCount?: number;
  expiryDate?: string; // yyyy-MM-dd
}

export const evergreenCategories = pgTable(
  'campaign_evergreen_categories',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
    color: varchar('color', { length: 20 }).notNull(),
    schedule: jsonb('schedule').$type<EvergreenCategoryScheduleJson>().notNull(),
    channelIds: jsonb('channel_ids').$type<string[]>().default([]).notNull(),
    seasonal: jsonb('seasonal').$type<EvergreenSeasonalJson | null>(),
    isActive: boolean('is_active').default(true).notNull(),
    rotationCursor: integer('rotation_cursor').default(0).notNull(),
    sortOrder: integer('sort_order').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uqCampaignName: uniqueIndex('evergreen_categories_campaign_name_uq').on(t.campaignId, t.name),
  }),
);

export const evergreenPosts = pgTable(
  'campaign_evergreen_posts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').notNull().references(() => evergreenCategories.id, { onDelete: 'cascade' }),
    content: jsonb('content').$type<ChannelDayContentJson>().notNull(),
    variations: jsonb('variations').$type<EvergreenVariationJson[]>().default([]).notNull(),
    recyclePolicy: jsonb('recycle_policy').$type<RecyclePolicyJson>().notNull(),
    minGapHours: integer('min_gap_hours').default(0).notNull(),
    recycledCount: integer('recycled_count').default(0).notNull(),
    lastPublishedAt: timestamp('last_published_at', { withTimezone: true }),
    performanceScore: real('performance_score'),
    isStale: boolean('is_stale').default(false).notNull(),
    staleReason: text('stale_reason'),
    status: varchar('status', { length: 20 }).$type<EvergreenPostStatus>().default('active').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idxCategoryStatus: index('evergreen_posts_category_status_idx').on(t.categoryId, t.status),
    idxCampaign: index('evergreen_posts_campaign_idx').on(t.campaignId),
  }),
);

export const evergreenOccurrences = pgTable(
  'campaign_evergreen_occurrences',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').notNull().references(() => evergreenCategories.id, { onDelete: 'cascade' }),
    postIdRef: uuid('post_id_ref').notNull().references(() => evergreenPosts.id, { onDelete: 'cascade' }),
    variationId: varchar('variation_id', { length: 64 }),
    channelId: varchar('channel_id', { length: 255 }).notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    slotStatus: varchar('slot_status', { length: 20 }).$type<CampaignSlotStatus>().default('scheduled').notNull(),
    postsRowId: uuid('posts_row_id'),
    jobId: varchar('job_id', { length: 160 }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idxCampaignScheduled: index('evergreen_occurrences_campaign_scheduled_idx').on(t.campaignId, t.scheduledAt),
    idxPostRef: index('evergreen_occurrences_post_ref_idx').on(t.postIdRef),
    idxJob: index('evergreen_occurrences_job_idx').on(t.jobId),
  }),
);

export const evergreenCategoriesRelations = relations(evergreenCategories, ({ one, many }) => ({
  campaign: one(campaigns, { fields: [evergreenCategories.campaignId], references: [campaigns.id] }),
  posts: many(evergreenPosts),
}));
export const evergreenPostsRelations = relations(evergreenPosts, ({ one }) => ({
  category: one(evergreenCategories, { fields: [evergreenPosts.categoryId], references: [evergreenCategories.id] }),
}));

export type EvergreenCategory = typeof evergreenCategories.$inferSelect;
export type NewEvergreenCategory = typeof evergreenCategories.$inferInsert;
export type EvergreenPost = typeof evergreenPosts.$inferSelect;
export type NewEvergreenPost = typeof evergreenPosts.$inferInsert;
export type EvergreenOccurrence = typeof evergreenOccurrences.$inferSelect;
export type NewEvergreenOccurrence = typeof evergreenOccurrences.$inferInsert;
