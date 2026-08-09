import {
  pgTable,
  uuid,
  text,
  timestamp,
  varchar,
  boolean,
  jsonb,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users.schema';
import { workspace } from './workspace.schema';

// =============================================================================
// Campaign Type / Status
// =============================================================================
export const CAMPAIGN_TYPES = ['bulk', 'drip', 'evergreen'] as const;
export type CampaignTypeDb = (typeof CAMPAIGN_TYPES)[number];

export const CAMPAIGN_STATUSES = [
  'draft',
  'scheduled',
  'active',
  'paused',
  'completed',
  'failed',
] as const;
export type CampaignStatusDb = (typeof CAMPAIGN_STATUSES)[number];

// =============================================================================
// Campaign Schedule JSON — mirrors the frontend `CampaignSchedule` union
// (bulk / drip / evergreen). Field names reproduced verbatim so the API
// round-trips without translation.
// =============================================================================
export interface CampaignScheduleBulkJson {
  type: 'bulk';
  startDate: string;
  endDate: string;
  defaultTime: string;
  timezone: string;
  perDayTimes?: Record<string, string>;
  blackoutDates: string[];
  skipWeekends: boolean;
}

export interface CampaignScheduleDripJson {
  type: 'drip';
  startDate: string;
  endDate: string | null;
  weekdays: number[];
  times: string[];
  timezone: string;
  blackoutDates: string[];
  maxPostCount?: number;
}

export interface CampaignScheduleEvergreenJson {
  type: 'evergreen';
  startDate: string;
  weekdays: number[];
  times: string[];
  timezone: string;
  blackoutDates: string[];
  loop: boolean;
}

export type CampaignScheduleJson =
  | CampaignScheduleBulkJson
  | CampaignScheduleDripJson
  | CampaignScheduleEvergreenJson;

// =============================================================================
// Channel Day Content JSON — mirrors the frontend `ChannelDayContent` shape.
// =============================================================================
export interface ChannelDayContentMediaJson {
  id: string;
  filename: string;
  kind: 'image' | 'video';
  url?: string;
}

export interface ChannelDayContentPollJson {
  question: string;
  options: string[];
  durationDays: number;
}

export interface ChannelDayContentJson {
  mode: 'manual' | 'library' | 'ai';
  postType: string;
  caption: string;
  media: ChannelDayContentMediaJson[];
  threadParts: string[];
  poll?: ChannelDayContentPollJson;
  templateIds: string[];
  aiSubState?: 'idle' | 'generating' | 'pending_review' | 'approved' | 'skipped';
  platformSpecific?: Record<string, unknown>;
}

// =============================================================================
// 1. Campaigns — main table for campaign configurations
// =============================================================================
export const campaigns = pgTable('campaigns', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'cascade' }),
  createdById: uuid('created_by_id')
    .notNull()
    .references(() => users.id, { onDelete: 'set null' }),

  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),

  type: varchar('type', { length: 20 }).notNull(),
  status: varchar('status', { length: 20 }).default('draft').notNull(),

  schedule: jsonb('schedule').$type<CampaignScheduleJson>().notNull(),

  contentSource: varchar('content_source', { length: 20 })
    .default('manual')
    .notNull(),

  // AiAutopilotConfig; kept loose server-side
  aiConfig: jsonb('ai_config').$type<Record<string, unknown> | null>(),

  libraryTemplateIds: jsonb('library_template_ids')
    .$type<string[]>()
    .default([]),

  // Cache of target channel ids / platforms (avoids joins for list views)
  channelIds: jsonb('channel_ids').$type<string[]>().default([]).notNull(),
  platforms: jsonb('platforms').$type<string[]>().default([]).notNull(),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// =============================================================================
// 2. Campaign Days — per-date state within a campaign (e.g. user-skipped days)
// =============================================================================
export const campaignDays = pgTable(
  'campaign_days',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),

    date: varchar('date', { length: 10 }).notNull(), // yyyy-MM-dd
    skip: boolean('skip').default(false).notNull(),

    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    uqCampaignDate: uniqueIndex('campaign_days_campaign_date_uq').on(
      t.campaignId,
      t.date,
    ),
  }),
);

// =============================================================================
// 3. Campaign Slot Content — per-date, per-channel content payload
// =============================================================================
export const campaignSlotContent = pgTable(
  'campaign_slot_content',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),

    date: varchar('date', { length: 10 }).notNull(), // yyyy-MM-dd
    channelId: varchar('channel_id', { length: 255 }).notNull(),

    content: jsonb('content').$type<ChannelDayContentJson>().notNull(),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    uqCampaignDateChannel: uniqueIndex(
      'campaign_slot_content_campaign_date_channel_uq',
    ).on(t.campaignId, t.date, t.channelId),
  }),
);

// =============================================================================
// Relations
// =============================================================================
export const campaignsRelations = relations(campaigns, ({ one, many }) => ({
  workspace: one(workspace, {
    fields: [campaigns.workspaceId],
    references: [workspace.id],
  }),
  createdBy: one(users, {
    fields: [campaigns.createdById],
    references: [users.id],
  }),
  days: many(campaignDays),
  slotContent: many(campaignSlotContent),
}));

export const campaignDaysRelations = relations(campaignDays, ({ one }) => ({
  campaign: one(campaigns, {
    fields: [campaignDays.campaignId],
    references: [campaigns.id],
  }),
}));

export const campaignSlotContentRelations = relations(
  campaignSlotContent,
  ({ one }) => ({
    campaign: one(campaigns, {
      fields: [campaignSlotContent.campaignId],
      references: [campaigns.id],
    }),
  }),
);

// =============================================================================
// Type Exports
// =============================================================================
export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;

export type CampaignDay = typeof campaignDays.$inferSelect;
export type NewCampaignDay = typeof campaignDays.$inferInsert;

export type CampaignSlotContent = typeof campaignSlotContent.$inferSelect;
export type NewCampaignSlotContent = typeof campaignSlotContent.$inferInsert;
