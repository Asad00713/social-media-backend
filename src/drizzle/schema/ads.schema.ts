import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  bigint,
  jsonb,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { workspace } from './workspace.schema';
import { socialMediaChannels } from './channels.schema';
import { users } from './users.schema';

export const adObjectiveEnum = pgEnum('ad_objective', [
  'OUTCOME_LEADS',
  'OUTCOME_ENGAGEMENT',
  'OUTCOME_AWARENESS',
]);
export const adEntityStatusEnum = pgEnum('ad_entity_status', [
  'ACTIVE',
  'PAUSED',
  'ARCHIVED',
  'DELETED',
  'PENDING_REVIEW',
  'DISAPPROVED',
  'WITH_ISSUES',
]);
export const adKindEnum = pgEnum('ad_kind', ['boost', 'lead_gen']);
export const leadDeliveryStatusEnum = pgEnum('lead_delivery_status', [
  'pending',
  'delivered',
  'failed',
  'partial',
]);
export const leadRouteTypeEnum = pgEnum('lead_route_type', [
  'inbox',
  'email',
  'webhook',
]);

export const adAccounts = pgTable(
  'ad_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .references(() => workspace.id, { onDelete: 'cascade' })
      .notNull(),
    channelId: integer('channel_id')
      .references(() => socialMediaChannels.id, { onDelete: 'cascade' })
      .notNull(),
    metaAdAccountId: varchar('meta_ad_account_id', { length: 64 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    currency: varchar('currency', { length: 8 }).notNull(),
    timezoneName: varchar('timezone_name', { length: 64 }).notNull(),
    accountStatus: integer('account_status').notNull(),
    businessId: varchar('business_id', { length: 64 }),
    disableReason: integer('disable_reason'),
    capabilities: jsonb('capabilities').$type<string[]>().default([]),
    fundingSource: jsonb('funding_source').$type<Record<string, unknown> | null>(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    lastSyncedAt: timestamp('last_synced_at'),
  },
  (t) => ({
    workspaceIdx: index('ad_accounts_workspace_idx').on(t.workspaceId),
    metaIdUniq: uniqueIndex('ad_accounts_meta_id_uniq').on(t.workspaceId, t.metaAdAccountId),
  }),
);

export const adCampaigns = pgTable(
  'ad_campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .references(() => workspace.id, { onDelete: 'cascade' })
      .notNull(),
    adAccountId: uuid('ad_account_id')
      .references(() => adAccounts.id, { onDelete: 'cascade' })
      .notNull(),
    channelId: integer('channel_id')
      .references(() => socialMediaChannels.id, { onDelete: 'cascade' })
      .notNull(),
    metaCampaignId: varchar('meta_campaign_id', { length: 64 }).notNull(),
    name: varchar('name', { length: 400 }).notNull(),
    objective: adObjectiveEnum('objective').notNull(),
    kind: adKindEnum('kind').notNull(),
    status: adEntityStatusEnum('status').notNull(),
    specialAdCategories: jsonb('special_ad_categories').$type<string[]>().default([]),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    workspaceStatusIdx: index('ad_campaigns_workspace_status_idx').on(t.workspaceId, t.status),
    metaIdUniq: uniqueIndex('ad_campaigns_meta_id_uniq').on(t.adAccountId, t.metaCampaignId),
  }),
);

export const adSets = pgTable(
  'ad_sets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .references(() => workspace.id, { onDelete: 'cascade' })
      .notNull(),
    campaignId: uuid('campaign_id')
      .references(() => adCampaigns.id, { onDelete: 'cascade' })
      .notNull(),
    metaAdsetId: varchar('meta_adset_id', { length: 64 }).notNull(),
    name: varchar('name', { length: 400 }).notNull(),
    status: adEntityStatusEnum('status').notNull(),
    dailyBudgetMinor: bigint('daily_budget_minor', { mode: 'number' }).notNull(),
    currency: varchar('currency', { length: 8 }).notNull(),
    startTime: timestamp('start_time'),
    endTime: timestamp('end_time'),
    optimizationGoal: varchar('optimization_goal', { length: 64 }).notNull(),
    billingEvent: varchar('billing_event', { length: 64 }).notNull(),
    targeting: jsonb('targeting').$type<Record<string, unknown>>().notNull(),
    promotedObject: jsonb('promoted_object').$type<Record<string, unknown> | null>(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    campaignIdx: index('ad_sets_campaign_idx').on(t.campaignId),
    metaIdUniq: uniqueIndex('ad_sets_meta_id_uniq').on(t.metaAdsetId),
  }),
);

export const ads = pgTable(
  'ads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .references(() => workspace.id, { onDelete: 'cascade' })
      .notNull(),
    adsetId: uuid('adset_id')
      .references(() => adSets.id, { onDelete: 'cascade' })
      .notNull(),
    metaAdId: varchar('meta_ad_id', { length: 64 }).notNull(),
    name: varchar('name', { length: 400 }).notNull(),
    status: adEntityStatusEnum('status').notNull(),
    metaCreativeId: varchar('meta_creative_id', { length: 64 }).notNull(),
    creativeSnapshot: jsonb('creative_snapshot').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    adsetIdx: index('ads_adset_idx').on(t.adsetId),
    metaIdUniq: uniqueIndex('ads_meta_id_uniq').on(t.metaAdId),
  }),
);

export const leadForms = pgTable(
  'lead_forms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .references(() => workspace.id, { onDelete: 'cascade' })
      .notNull(),
    channelId: integer('channel_id')
      .references(() => socialMediaChannels.id, { onDelete: 'cascade' })
      .notNull(),
    metaFormId: varchar('meta_form_id', { length: 64 }).notNull(),
    name: varchar('name', { length: 400 }).notNull(),
    locale: varchar('locale', { length: 16 }).default('en_US').notNull(),
    questionsSnapshot: jsonb('questions_snapshot')
      .$type<Record<string, unknown>[]>()
      .notNull(),
    privacyPolicyUrl: text('privacy_policy_url').notNull(),
    thankYouSnapshot: jsonb('thank_you_snapshot')
      .$type<Record<string, unknown>>()
      .notNull(),
    introSnapshot: jsonb('intro_snapshot').$type<Record<string, unknown> | null>(),
    status: varchar('status', { length: 32 }).default('active').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    workspaceIdx: index('lead_forms_workspace_idx').on(t.workspaceId),
    metaIdUniq: uniqueIndex('lead_forms_meta_id_uniq').on(t.metaFormId),
  }),
);

export const leadRoutes = pgTable(
  'lead_routes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .references(() => workspace.id, { onDelete: 'cascade' })
      .notNull(),
    leadFormId: uuid('lead_form_id')
      .references(() => leadForms.id, { onDelete: 'cascade' })
      .notNull(),
    type: leadRouteTypeEnum('type').notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    formIdx: index('lead_routes_form_idx').on(t.leadFormId),
  }),
);

export const leads = pgTable(
  'leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .references(() => workspace.id, { onDelete: 'cascade' })
      .notNull(),
    leadFormId: uuid('lead_form_id')
      .references(() => leadForms.id, { onDelete: 'cascade' })
      .notNull(),
    metaLeadgenId: varchar('meta_leadgen_id', { length: 64 }).notNull(),
    metaAdId: varchar('meta_ad_id', { length: 64 }),
    fieldData: jsonb('field_data')
      .$type<Array<{ name: string; values: string[] }>>()
      .notNull(),
    isOrganic: boolean('is_organic').default(false).notNull(),
    capturedAt: timestamp('captured_at').notNull(),
    deliveryStatus: leadDeliveryStatusEnum('delivery_status').default('pending').notNull(),
    deliveryAttempts: jsonb('delivery_attempts')
      .$type<
        Array<{ type: string; status: 'success' | 'failed'; at: string; error?: string }>
      >()
      .default([])
      .notNull(),
    inboxItemId: uuid('inbox_item_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    workspaceIdx: index('leads_workspace_idx').on(t.workspaceId),
    formIdx: index('leads_form_idx').on(t.leadFormId),
    metaIdUniq: uniqueIndex('leads_meta_id_uniq').on(t.metaLeadgenId),
  }),
);

export const adInsightsDaily = pgTable(
  'ad_insights_daily',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .references(() => workspace.id, { onDelete: 'cascade' })
      .notNull(),
    adsetId: uuid('adset_id')
      .references(() => adSets.id, { onDelete: 'cascade' })
      .notNull(),
    date: varchar('date', { length: 10 }).notNull(),
    impressions: bigint('impressions', { mode: 'number' }).default(0).notNull(),
    reach: bigint('reach', { mode: 'number' }).default(0).notNull(),
    clicks: bigint('clicks', { mode: 'number' }).default(0).notNull(),
    spendMinor: bigint('spend_minor', { mode: 'number' }).default(0).notNull(),
    leadsCount: bigint('leads_count', { mode: 'number' }).default(0).notNull(),
    actions: jsonb('actions').$type<Record<string, number>>().default({}).notNull(),
    fetchedAt: timestamp('fetched_at').defaultNow().notNull(),
  },
  (t) => ({
    adsetDateUniq: uniqueIndex('ad_insights_adset_date_uniq').on(t.adsetId, t.date),
  }),
);

export const adDrafts = pgTable(
  'ad_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .references(() => workspace.id, { onDelete: 'cascade' })
      .notNull(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    kind: adKindEnum('kind').notNull(),
    state: jsonb('state').$type<Record<string, unknown>>().notNull(),
    currentStep: varchar('current_step', { length: 64 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('ad_drafts_user_idx').on(t.userId),
  }),
);

// =============================================================================
// Type Exports
// =============================================================================
export type AdAccount = typeof adAccounts.$inferSelect;
export type NewAdAccount = typeof adAccounts.$inferInsert;

export type AdCampaign = typeof adCampaigns.$inferSelect;
export type NewAdCampaign = typeof adCampaigns.$inferInsert;

export type AdSet = typeof adSets.$inferSelect;
export type NewAdSet = typeof adSets.$inferInsert;

export type Ad = typeof ads.$inferSelect;
export type NewAd = typeof ads.$inferInsert;

export type LeadForm = typeof leadForms.$inferSelect;
export type NewLeadForm = typeof leadForms.$inferInsert;

export type LeadRoute = typeof leadRoutes.$inferSelect;
export type NewLeadRoute = typeof leadRoutes.$inferInsert;

export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;

export type AdInsightsDaily = typeof adInsightsDaily.$inferSelect;
export type NewAdInsightsDaily = typeof adInsightsDaily.$inferInsert;

export type AdDraft = typeof adDrafts.$inferSelect;
export type NewAdDraft = typeof adDrafts.$inferInsert;
