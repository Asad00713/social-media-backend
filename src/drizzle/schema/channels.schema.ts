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
  'bluesky',
  'mastodon',
  'google_business',
  'google_drive',
  'google_photos',
  'google_calendar',
  'onedrive',
  'dropbox',
  'reddit',
  'slack',
  'telegram',
  'discord',
  'whatsapp',
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
  'workspace',
  'bot',
  'server',
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
    platformAccountId: varchar('platform_account_id', {
      length: 255,
    }).notNull(), // ID from the platform

    // Display information
    accountName: varchar('account_name', { length: 255 }).notNull(),
    username: varchar('username', { length: 255 }), // @handle
    profilePictureUrl: text('profile_picture_url'),

    // Webhook routing (for inbox and custom bot functionality)
    telegramWebhookRouteId: text('telegram_webhook_route_id').unique(),

    // OAuth tokens (encrypted in application layer)
    accessToken: text('access_token').notNull(),
    refreshToken: text('refresh_token'),
    tokenExpiresAt: timestamp('token_expires_at'),
    refreshTokenIssuedAt: timestamp('refresh_token_issued_at', {
      withTimezone: true,
    }),
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
    // Last time the inbox poller fetched comments for this channel.
    // Used by INBOX_POLLING worker for YT/Bluesky/Mastodon (no webhooks).
    lastInboxPollAt: timestamp('last_inbox_poll_at'),

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

/**
 * Returns the effective refresh-token TTL (in days) for a platform.
 *
 * Priority: env var `<PLATFORM_UPPER>_REFRESH_TOKEN_TTL_DAYS` > PLATFORM_CONFIG default.
 * Returns null when the platform's refresh token never expires.
 *
 * Example env overrides:
 *   YOUTUBE_REFRESH_TOKEN_TTL_DAYS=36500   (published Google OAuth app)
 *   GOOGLE_BUSINESS_REFRESH_TOKEN_TTL_DAYS=36500
 */
export function getRefreshTokenTtlDays(
  platform: SupportedPlatform,
): number | null {
  const envKey = `${platform.toUpperCase().replace(/-/g, '_')}_REFRESH_TOKEN_TTL_DAYS`;
  const envValue = process.env[envKey];
  if (envValue) {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return PLATFORM_CONFIG[platform]?.refreshTokenTtlDays ?? null;
}

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
    refreshTokenTtlDays: number | null; // null = refresh token doesn't expire
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
    refreshTokenTtlDays: 60, // Long-lived token acts as the refresh token
    maxMediaPerPost: 10,
    maxTextLength: 63206,
    supportedMediaTypes: ['image', 'video', 'link'],
    oauthScopes: [
      // Only scopes that are "Ready for testing" in Meta App Console
      'public_profile',
      'pages_show_list',
      'pages_read_engagement',
      'pages_manage_posts',
      'pages_manage_metadata',
      // Required for posting comments on Page posts (first-comment feature).
      // Must be enabled in Meta App Console → App Review → Permissions and Features
      // before existing users will see it in the consent screen.
      'pages_manage_engagement',
      // Required to read user-generated comments on Page posts (inbox feature).
      'pages_read_user_content',
      // === Ads Phase 1 additions ===
      // Must be approved in Meta App Console before existing users will see them.
      'ads_management',
      'ads_read',
      'leads_retrieval',
      'pages_manage_ads',
      'business_management',
    ],
  },
  instagram: {
    name: 'Instagram',
    accountTypes: ['business_account'],
    supportsRefreshToken: false, // Instagram Business Login uses long-lived tokens (60 days)
    tokenExpirationDays: 60,
    refreshTokenTtlDays: 60, // Long-lived token must be refreshed within 60 days
    maxMediaPerPost: 10,
    maxTextLength: 2200,
    supportedMediaTypes: ['image', 'video', 'carousel'],
    oauthScopes: [
      // Instagram Business Login scopes (July 2024+)
      'instagram_business_basic',
      'instagram_business_manage_messages',
      'instagram_business_manage_comments',
      'instagram_business_content_publish',
      // Required for reading IG insights when an FB ad targets IG placements.
      'instagram_manage_insights',
    ],
  },
  youtube: {
    name: 'YouTube',
    accountTypes: ['channel'],
    supportsRefreshToken: true,
    tokenExpirationDays: null, // Refresh token doesn't expire
    refreshTokenTtlDays: 7, // Testing-mode Google apps; override via YOUTUBE_REFRESH_TOKEN_TTL_DAYS=36500 for published apps
    maxMediaPerPost: 1,
    maxTextLength: 5000,
    supportedMediaTypes: ['video'],
    oauthScopes: [
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube',
      'https://www.googleapis.com/auth/yt-analytics.readonly',
      // Required for commentThreads.insert (first-comment feature).
      // The broader youtube scope does NOT cover comment writes — verified at runtime.
      'https://www.googleapis.com/auth/youtube.force-ssl',
    ],
  },
  tiktok: {
    name: 'TikTok',
    accountTypes: ['business_account'],
    supportsRefreshToken: true,
    tokenExpirationDays: 1, // Very short
    refreshTokenTtlDays: 365,
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
    refreshTokenTtlDays: 365,
    maxMediaPerPost: 1,
    maxTextLength: 500,
    supportedMediaTypes: ['image', 'video'],
    oauthScopes: [
      'user_accounts:read',
      'boards:read',
      'boards:write',
      'pins:read',
      'pins:write',
    ],
  },
  twitter: {
    name: 'X (Twitter)',
    accountTypes: ['profile'],
    supportsRefreshToken: true,
    tokenExpirationDays: null,
    refreshTokenTtlDays: 180,
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
    refreshTokenTtlDays: 60,
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
    refreshTokenTtlDays: 60,
    maxMediaPerPost: 10,
    maxTextLength: 500,
    supportedMediaTypes: ['image', 'video'],
    oauthScopes: [
      'threads_basic',
      'threads_content_publish',
      // Required to use reply_to_id when chaining a multi-post thread.
      // Without this, the first post publishes but subsequent replies fail
      // with THApiException code 10 "Application does not have permission".
      'threads_manage_replies',
      // Required to read replies on our Threads posts (inbox feature).
      'threads_read_replies',
    ],
  },
  bluesky: {
    name: 'Bluesky',
    accountTypes: ['profile'],
    supportsRefreshToken: true, // Uses session refresh
    tokenExpirationDays: null, // Sessions can be refreshed indefinitely
    refreshTokenTtlDays: null, // App Passwords don't expire
    maxMediaPerPost: 4,
    maxTextLength: 300,
    supportedMediaTypes: ['image', 'video'],
    oauthScopes: [], // Uses App Passwords, not OAuth
  },
  mastodon: {
    name: 'Mastodon',
    accountTypes: ['profile'],
    supportsRefreshToken: false, // Mastodon tokens don't expire by default
    tokenExpirationDays: null, // Tokens don't expire unless revoked
    refreshTokenTtlDays: null, // No refresh token; access token doesn't expire
    maxMediaPerPost: 4,
    maxTextLength: 500, // Default, can vary by instance
    supportedMediaTypes: ['image', 'video', 'gif'],
    oauthScopes: ['read', 'write', 'follow'], // Standard Mastodon scopes
  },
  // Google services - these share the same OAuth app but different scopes
  google_business: {
    name: 'Google Business',
    accountTypes: ['business_account'],
    supportsRefreshToken: true,
    tokenExpirationDays: null,
    refreshTokenTtlDays: 7, // Google testing-mode default; override via GOOGLE_BUSINESS_REFRESH_TOKEN_TTL_DAYS
    maxMediaPerPost: 10,
    maxTextLength: 1500,
    supportedMediaTypes: ['image', 'video'],
    oauthScopes: ['https://www.googleapis.com/auth/business.manage'],
  },
  reddit: {
    name: 'Reddit',
    accountTypes: ['profile'],
    supportsRefreshToken: true,
    tokenExpirationDays: null, // Reddit access tokens last 1 hour
    refreshTokenTtlDays: 365, // Reddit refresh tokens are permanent if duration=permanent
    maxMediaPerPost: 1,
    maxTextLength: 40000,
    supportedMediaTypes: ['image'],
    oauthScopes: ['identity', 'submit', 'read', 'mysubreddits', 'flair'],
  },
  google_drive: {
    name: 'Google Drive',
    accountTypes: ['storage'],
    supportsRefreshToken: true,
    tokenExpirationDays: null,
    refreshTokenTtlDays: 7, // Google testing-mode default; override via GOOGLE_DRIVE_REFRESH_TOKEN_TTL_DAYS
    maxMediaPerPost: 0, // Not a posting platform
    maxTextLength: 0,
    supportedMediaTypes: ['image', 'video', 'document'],
    oauthScopes: ['https://www.googleapis.com/auth/drive.readonly'],
  },
  google_photos: {
    name: 'Google Photos',
    accountTypes: ['storage'],
    supportsRefreshToken: true,
    tokenExpirationDays: null,
    refreshTokenTtlDays: 7, // Google testing-mode default; override via GOOGLE_PHOTOS_REFRESH_TOKEN_TTL_DAYS
    maxMediaPerPost: 0, // Not a posting platform
    maxTextLength: 0,
    supportedMediaTypes: ['image', 'video'],
    oauthScopes: ['https://www.googleapis.com/auth/photoslibrary.readonly'],
  },
  google_calendar: {
    name: 'Google Calendar',
    accountTypes: ['storage'], // Not a posting platform, utility service
    supportsRefreshToken: true,
    tokenExpirationDays: null,
    refreshTokenTtlDays: 7, // Google testing-mode default; override via GOOGLE_CALENDAR_REFRESH_TOKEN_TTL_DAYS
    maxMediaPerPost: 0,
    maxTextLength: 0,
    supportedMediaTypes: [],
    oauthScopes: [
      'https://www.googleapis.com/auth/calendar.events', // Create/update/delete events
      'https://www.googleapis.com/auth/calendar.readonly', // Read calendars list
    ],
  },
  onedrive: {
    name: 'OneDrive',
    accountTypes: ['storage'],
    supportsRefreshToken: true,
    tokenExpirationDays: null, // Refresh token doesn't expire if used regularly
    refreshTokenTtlDays: 60, // Microsoft consumer tokens inactive for 90 days expire; warn at 60
    maxMediaPerPost: 0, // Not a posting platform
    maxTextLength: 0,
    supportedMediaTypes: ['image', 'video', 'document'],
    oauthScopes: [
      // Consumer OneDrive scopes (wl.* scopes for personal accounts)
      'wl.signin',
      'wl.skydrive',
      'wl.skydrive_update',
      'wl.offline_access',
    ],
  },
  dropbox: {
    name: 'Dropbox',
    accountTypes: ['storage'],
    supportsRefreshToken: true,
    tokenExpirationDays: null, // Short-lived access tokens with refresh
    refreshTokenTtlDays: 60, // Dropbox offline tokens expire after inactivity; conservative estimate
    maxMediaPerPost: 0, // Not a posting platform
    maxTextLength: 0,
    supportedMediaTypes: ['image', 'video', 'document'],
    oauthScopes: [
      'account_info.read',
      'files.metadata.read',
      'files.content.read',
    ],
  },
  slack: {
    name: 'Slack',
    accountTypes: ['workspace'],
    supportsRefreshToken: true,
    tokenExpirationDays: null, // Slack bot tokens don't expire unless revoked
    refreshTokenTtlDays: null,
    maxMediaPerPost: 0, // Inbox/notification platform, not a publishing target
    maxTextLength: 40000,
    supportedMediaTypes: [],
    oauthScopes: [
      // Public channels
      'channels:read',
      'channels:history',
      'channels:join',
      'channels:manage',
      // Private channels (groups)
      'groups:read',
      'groups:history',
      'groups:write',
      // Direct messages
      'im:read',
      'im:history',
      'im:write',
      // Group direct messages (mpim)
      'mpim:read',
      'mpim:history',
      'mpim:write',
      // Posting + files
      'chat:write',
      'chat:write.public',
      'files:write',
      // Users / mentions / workspace
      'users:read',
      'app_mentions:read',
      'team:read',
    ],
  },
  telegram: {
    name: 'Telegram',
    accountTypes: ['bot'],
    supportsRefreshToken: false, // Bot tokens don't expire
    tokenExpirationDays: null,
    refreshTokenTtlDays: null,
    maxMediaPerPost: 0, // Inbox/notification platform, not a publishing target
    maxTextLength: 4096,
    supportedMediaTypes: [],
    oauthScopes: [], // Uses Bot API token, not OAuth
  },
  discord: {
    name: 'Discord',
    accountTypes: ['server'],
    supportsRefreshToken: true,
    tokenExpirationDays: null,
    refreshTokenTtlDays: null,
    maxMediaPerPost: 0, // Inbox/notification platform, not a publishing target
    maxTextLength: 2000,
    supportedMediaTypes: [],
    oauthScopes: ['bot', 'guilds', 'messages.read'],
  },
  whatsapp: {
    name: 'WhatsApp',
    accountTypes: ['business_account'],
    supportsRefreshToken: false,
    tokenExpirationDays: null,
    refreshTokenTtlDays: null,
    maxMediaPerPost: 0,
    maxTextLength: 4096,
    supportedMediaTypes: [],
    oauthScopes: ['whatsapp_business_messaging', 'whatsapp_business_management'],
  },
};
