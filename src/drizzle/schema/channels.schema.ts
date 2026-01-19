import {
  pgTable,
  uuid,
  text,
  timestamp,
  varchar,
  integer,
  boolean,
  jsonb,
  bigserial,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users.schema';
import { workspace } from './workspace.schema';

// Platform enum values
export const SUPPORTED_PLATFORMS = [
  'facebook',
  'instagram',
  'youtube',
  'tiktok',
  'pinterest',
  'twitter',
  'linkedin',
  'threads',
  'google_drive',
  'google_photos',
] as const;

export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

// Account type enum values
export const ACCOUNT_TYPES = [
  'page',
  'profile',
  'channel',
  'business_account',
  'group',
  'storage', // For Google Drive, Google Photos
] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];

// Connection status enum values
export const CONNECTION_STATUSES = [
  'connected',
  'expired',
  'revoked',
  'error',
  'refreshing',
] as const;

export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

// Channel relationship types
export const RELATIONSHIP_TYPES = [
  'fb_user_to_page',
  'ig_business_to_fb_page',
  'yt_brand_to_channel',
  'linkedin_user_to_page',
] as const;

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

// =============================================================================
// 1. Social Media Channels - Main table for connected accounts
// =============================================================================
export const socialMediaChannels = pgTable(
  'social_media_channels',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),

    // Platform identification
    platform: varchar('platform', { length: 20 }).notNull(), // facebook, instagram, etc.
    accountType: varchar('account_type', { length: 30 }).notNull(), // page, profile, channel, etc.
    platformAccountId: varchar('platform_account_id', { length: 255 }).notNull(), // ID from the platform

    // Display information
    accountName: varchar('account_name', { length: 255 }).notNull(),
    username: varchar('username', { length: 255 }), // @handle
    profilePictureUrl: text('profile_picture_url'),

    // OAuth tokens (encrypted in application layer)
    accessToken: text('access_token').notNull(),
    refreshToken: text('refresh_token'),
    tokenExpiresAt: timestamp('token_expires_at'),
    tokenScope: text('token_scope'), // Granted OAuth scopes

    // Permissions and capabilities
    permissions: jsonb('permissions').$type<string[]>().default([]),
    capabilities: jsonb('capabilities').$type<{
      canPost: boolean;
      canSchedule: boolean;
      canReadAnalytics: boolean;
      canReply: boolean;
      canDelete: boolean;
      supportedMediaTypes: string[];
      maxMediaPerPost: number;
      maxTextLength: number;
    }>(),

    // Status and health
    isActive: boolean('is_active').default(true).notNull(),
    connectionStatus: varchar('connection_status', { length: 20 })
      .default('connected')
      .notNull(),
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at'),
    consecutiveErrors: integer('consecutive_errors').default(0).notNull(),

    // Sync information
    lastSyncedAt: timestamp('last_synced_at'),
    lastPostedAt: timestamp('last_posted_at'),

    // Platform-specific metadata (flexible JSON)
    metadata: jsonb('metadata').$type<Record<string, any>>().default({}),

    // User tracking
    connectedByUserId: uuid('connected_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'set null' }),

    // Display preferences
    displayOrder: integer('display_order').default(0).notNull(),
    timezone: varchar('timezone', { length: 50 }).default('UTC'),
    color: varchar('color', { length: 7 }), // Hex color for UI

    // Timestamps
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    // Indexes for common queries
    workspaceIdx: index('channels_workspace_idx').on(table.workspaceId),
    platformIdx: index('channels_platform_idx').on(table.platform),
    statusIdx: index('channels_status_idx').on(table.connectionStatus),
    // Unique constraint: one platform account per workspace
    uniquePlatformAccount: unique('unique_platform_account').on(
      table.workspaceId,
      table.platform,
      table.platformAccountId,
    ),
  }),
);

// =============================================================================
// 2. Channel Relationships - For platforms with parent/child accounts
// =============================================================================
export const channelRelationships = pgTable(
  'channel_relationships',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    parentChannelId: integer('parent_channel_id')
      .notNull()
      .references(() => socialMediaChannels.id, { onDelete: 'cascade' }),
    childChannelId: integer('child_channel_id')
      .notNull()
      .references(() => socialMediaChannels.id, { onDelete: 'cascade' }),
    relationshipType: varchar('relationship_type', { length: 50 }).notNull(),
    metadata: jsonb('metadata').$type<Record<string, any>>().default({}),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    uniqueRelationship: unique('unique_channel_relationship').on(
      table.parentChannelId,
      table.childChannelId,
      table.relationshipType,
    ),
    parentIdx: index('relationship_parent_idx').on(table.parentChannelId),
    childIdx: index('relationship_child_idx').on(table.childChannelId),
  }),
);

// =============================================================================
// 3. OAuth States - For secure OAuth flow (CSRF protection)
// =============================================================================
export const oauthStates = pgTable(
  'oauth_states',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    stateToken: varchar('state_token', { length: 64 }).notNull().unique(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: varchar('platform', { length: 20 }).notNull(),
    redirectUrl: text('redirect_url'),
    codeVerifier: varchar('code_verifier', { length: 128 }), // For PKCE
    additionalData: jsonb('additional_data').$type<Record<string, any>>(),
    expiresAt: timestamp('expires_at').notNull(),
    usedAt: timestamp('used_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    stateTokenIdx: index('oauth_state_token_idx').on(table.stateToken),
    expiresIdx: index('oauth_expires_idx').on(table.expiresAt),
  }),
);

// =============================================================================
// 4. Token Refresh Log - Audit trail for debugging token issues
// =============================================================================
export const tokenRefreshLogs = pgTable(
  'token_refresh_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    channelId: integer('channel_id')
      .notNull()
      .references(() => socialMediaChannels.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 20 }).notNull(), // success, failed
    errorMessage: text('error_message'),
    errorCode: varchar('error_code', { length: 50 }),
    oldExpiresAt: timestamp('old_expires_at'),
    newExpiresAt: timestamp('new_expires_at'),
    requestDurationMs: integer('request_duration_ms'),
    metadata: jsonb('metadata').$type<Record<string, any>>(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    channelIdx: index('token_refresh_channel_idx').on(table.channelId),
    statusIdx: index('token_refresh_status_idx').on(table.status),
    createdIdx: index('token_refresh_created_idx').on(table.createdAt),
  }),
);

// =============================================================================
// 5. Platform Credentials - Store app credentials per platform (admin use)
// =============================================================================
export const platformCredentials = pgTable('platform_credentials', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  platform: varchar('platform', { length: 20 }).notNull().unique(),
  clientId: text('client_id').notNull(),
  clientSecret: text('client_secret').notNull(), // Encrypted
  additionalConfig: jsonb('additional_config').$type<Record<string, any>>(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// =============================================================================
// Relations
// =============================================================================
export const socialMediaChannelsRelations = relations(
  socialMediaChannels,
  ({ one, many }) => ({
    workspace: one(workspace, {
      fields: [socialMediaChannels.workspaceId],
      references: [workspace.id],
    }),
    connectedByUser: one(users, {
      fields: [socialMediaChannels.connectedByUserId],
      references: [users.id],
    }),
    parentRelationships: many(channelRelationships, {
      relationName: 'parentChannel',
    }),
    childRelationships: many(channelRelationships, {
      relationName: 'childChannel',
    }),
    tokenRefreshLogs: many(tokenRefreshLogs),
  }),
);

export const channelRelationshipsRelations = relations(
  channelRelationships,
  ({ one }) => ({
    parentChannel: one(socialMediaChannels, {
      fields: [channelRelationships.parentChannelId],
      references: [socialMediaChannels.id],
      relationName: 'parentChannel',
    }),
    childChannel: one(socialMediaChannels, {
      fields: [channelRelationships.childChannelId],
      references: [socialMediaChannels.id],
      relationName: 'childChannel',
    }),
  }),
);

export const oauthStatesRelations = relations(oauthStates, ({ one }) => ({
  workspace: one(workspace, {
    fields: [oauthStates.workspaceId],
    references: [workspace.id],
  }),
  user: one(users, {
    fields: [oauthStates.userId],
    references: [users.id],
  }),
}));

export const tokenRefreshLogsRelations = relations(
  tokenRefreshLogs,
  ({ one }) => ({
    channel: one(socialMediaChannels, {
      fields: [tokenRefreshLogs.channelId],
      references: [socialMediaChannels.id],
    }),
  }),
);

// =============================================================================
// Type Exports
// =============================================================================
export type SocialMediaChannel = typeof socialMediaChannels.$inferSelect;
export type NewSocialMediaChannel = typeof socialMediaChannels.$inferInsert;

export type ChannelRelationship = typeof channelRelationships.$inferSelect;
export type NewChannelRelationship = typeof channelRelationships.$inferInsert;

export type OAuthState = typeof oauthStates.$inferSelect;
export type NewOAuthState = typeof oauthStates.$inferInsert;

export type TokenRefreshLog = typeof tokenRefreshLogs.$inferSelect;
export type NewTokenRefreshLog = typeof tokenRefreshLogs.$inferInsert;

export type PlatformCredential = typeof platformCredentials.$inferSelect;
export type NewPlatformCredential = typeof platformCredentials.$inferInsert;

// =============================================================================
// Platform Configuration Constants
// =============================================================================
export const PLATFORM_CONFIG: Record<
  SupportedPlatform,
  {
    name: string;
    accountTypes: AccountType[];
    supportsRefreshToken: boolean;
    tokenExpirationDays: number | null; // null = doesn't expire
    maxMediaPerPost: number;
    maxTextLength: number;
    supportedMediaTypes: string[];
    oauthScopes: string[];
  }
> = {
  facebook: {
    name: 'Facebook',
    accountTypes: ['page', 'group'],
    supportsRefreshToken: false, // Uses long-lived tokens
    tokenExpirationDays: 60,
    maxMediaPerPost: 10,
    maxTextLength: 63206,
    supportedMediaTypes: ['image', 'video', 'link'],
    oauthScopes: [
      'pages_show_list',
      'pages_read_engagement',
      'pages_manage_posts',
      'pages_manage_metadata',
    ],
  },
  instagram: {
    name: 'Instagram',
    accountTypes: ['business_account'],
    supportsRefreshToken: false, // Uses FB token
    tokenExpirationDays: 60,
    maxMediaPerPost: 10,
    maxTextLength: 2200,
    supportedMediaTypes: ['image', 'video', 'carousel'],
    oauthScopes: [
      'instagram_basic',
      'instagram_content_publish',
      // 'instagram_manage_insights', // Requires App Review approval - add back after approval
    ],
  },
  youtube: {
    name: 'YouTube',
    accountTypes: ['channel'],
    supportsRefreshToken: true,
    tokenExpirationDays: null, // Refresh token doesn't expire
    maxMediaPerPost: 1,
    maxTextLength: 5000,
    supportedMediaTypes: ['video'],
    oauthScopes: [
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube',
    ],
  },
  tiktok: {
    name: 'TikTok',
    accountTypes: ['business_account'],
    supportsRefreshToken: true,
    tokenExpirationDays: 1, // Very short
    maxMediaPerPost: 1,
    maxTextLength: 2200,
    supportedMediaTypes: ['video'],
    oauthScopes: [
      'user.info.basic',
      'user.info.profile',
      'user.info.stats',
      'video.list',
      'video.upload',
      'video.publish',
    ],
  },
  pinterest: {
    name: 'Pinterest',
    accountTypes: ['business_account', 'profile'],
    supportsRefreshToken: true,
    tokenExpirationDays: 30,
    maxMediaPerPost: 1,
    maxTextLength: 500,
    supportedMediaTypes: ['image', 'video'],
    oauthScopes: ['user_accounts:read', 'boards:read', 'boards:write', 'pins:read', 'pins:write'],
  },
  twitter: {
    name: 'X (Twitter)',
    accountTypes: ['profile'],
    supportsRefreshToken: true,
    tokenExpirationDays: null,
    maxMediaPerPost: 4,
    maxTextLength: 280,
    supportedMediaTypes: ['image', 'video', 'gif'],
    oauthScopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
  },
  linkedin: {
    name: 'LinkedIn',
    accountTypes: ['profile', 'page'],
    supportsRefreshToken: true,
    tokenExpirationDays: 60,
    maxMediaPerPost: 9,
    maxTextLength: 3000,
    supportedMediaTypes: ['image', 'video', 'document'],
    oauthScopes: ['openid', 'profile', 'email', 'w_member_social'],
  },
  threads: {
    name: 'Threads',
    accountTypes: ['profile'],
    supportsRefreshToken: false, // Uses IG token
    tokenExpirationDays: 60,
    maxMediaPerPost: 10,
    maxTextLength: 500,
    supportedMediaTypes: ['image', 'video'],
    oauthScopes: ['threads_basic', 'threads_content_publish'],
  },
  // Google services - these share the same OAuth app but different scopes
  google_drive: {
    name: 'Google Drive',
    accountTypes: ['storage'],
    supportsRefreshToken: true,
    tokenExpirationDays: null,
    maxMediaPerPost: 0, // Not a posting platform
    maxTextLength: 0,
    supportedMediaTypes: ['image', 'video', 'document'],
    oauthScopes: [
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  },
  google_photos: {
    name: 'Google Photos',
    accountTypes: ['storage'],
    supportsRefreshToken: true,
    tokenExpirationDays: null,
    maxMediaPerPost: 0, // Not a posting platform
    maxTextLength: 0,
    supportedMediaTypes: ['image', 'video'],
    oauthScopes: [
      'https://www.googleapis.com/auth/photoslibrary.readonly',
    ],
  },
};
