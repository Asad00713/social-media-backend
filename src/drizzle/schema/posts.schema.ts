import {
  pgTable,
  uuid,
  text,
  timestamp,
  varchar,
  jsonb,
  index,
  integer,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users.schema';
import { workspace } from './workspace.schema';
import { socialMediaChannels, SupportedPlatform } from './channels.schema';

// Post status enum values
export const POST_STATUSES = [
  'draft',
  'scheduled',
  'publishing',
  'published',
  'failed',
  'partially_published',
] as const;

export type PostStatus = (typeof POST_STATUSES)[number];

// Media type enum values
export const MEDIA_TYPES = ['image', 'video', 'gif', 'carousel'] as const;

export type MediaType = (typeof MEDIA_TYPES)[number];

// Media item interface
export interface MediaItem {
  url: string;
  type: MediaType;
  thumbnailUrl?: string;
  altText?: string;
  width?: number;
  height?: number;
  duration?: number; // For videos, in seconds
}

// Platform-specific content overrides
export interface PlatformContent {
  text?: string;
  mediaItems?: MediaItem[];
  metadata?: Record<string, any>;
}

// Post target - which channel to publish to and its status
export interface PostTarget {
  channelId: string;
  platform: SupportedPlatform;
  status: PostStatus;
  platformPostId?: string;
  platformPostUrl?: string;
  publishedAt?: string;
  errorMessage?: string;
  contentOverride?: PlatformContent;
}

/**
 * Posts table - stores all posts (drafts, scheduled, published)
 */
export const posts = pgTable(
  'posts',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Ownership
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // Content
    content: text('content'), // Main text content
    mediaItems: jsonb('media_items').$type<MediaItem[]>().default([]),

    // Targets - which channels to publish to
    targets: jsonb('targets').$type<PostTarget[]>().notNull().default([]),

    // Status
    status: varchar('status', { length: 50 })
      .$type<PostStatus>()
      .notNull()
      .default('draft'),

    // Scheduling
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),

    // Platform-specific content (allows different content per platform)
    platformContent: jsonb('platform_content')
      .$type<Partial<Record<SupportedPlatform, PlatformContent>>>()
      .default({}),

    // Additional metadata
    metadata: jsonb('metadata')
      .$type<{
        hashtags?: string[];
        mentions?: string[];
        location?: { name: string; id?: string };
        firstComment?: string; // For Instagram first comment
        linkPreview?: { url: string; title?: string; description?: string };
        [key: string]: any;
      }>()
      .default({}),

    // Job tracking (for BullMQ)
    jobId: varchar('job_id', { length: 100 }), // BullMQ job ID for scheduled posts

    // Error tracking
    lastError: text('last_error'),
    retryCount: varchar('retry_count', { length: 10 }).default('0'),

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('posts_workspace_id_idx').on(table.workspaceId),
    index('posts_created_by_id_idx').on(table.createdById),
    index('posts_status_idx').on(table.status),
    index('posts_scheduled_at_idx').on(table.scheduledAt),
    index('posts_created_at_idx').on(table.createdAt),
  ],
);

/**
 * Post history - tracks all publishing attempts and status changes
 */
export const postHistory = pgTable(
  'post_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),

    // What happened
    action: varchar('action', { length: 50 }).notNull(), // created, updated, scheduled, publishing, published, failed, retried
    previousStatus: varchar('previous_status', { length: 50 }),
    newStatus: varchar('new_status', { length: 50 }),

    // Which channel (if applicable)
    channelId: integer('channel_id').references(() => socialMediaChannels.id, {
      onDelete: 'set null',
    }),
    platform: varchar('platform', { length: 50 }),

    // Details
    details: jsonb('details').$type<{
      platformPostId?: string;
      platformPostUrl?: string;
      errorMessage?: string;
      [key: string]: any;
    }>(),

    // Who made the change
    performedById: uuid('performed_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('post_history_post_id_idx').on(table.postId),
    index('post_history_channel_id_idx').on(table.channelId),
    index('post_history_created_at_idx').on(table.createdAt),
  ],
);

// Relations
export const postsRelations = relations(posts, ({ one, many }) => ({
  workspace: one(workspace, {
    fields: [posts.workspaceId],
    references: [workspace.id],
  }),
  createdBy: one(users, {
    fields: [posts.createdById],
    references: [users.id],
  }),
  history: many(postHistory),
}));

export const postHistoryRelations = relations(postHistory, ({ one }) => ({
  post: one(posts, {
    fields: [postHistory.postId],
    references: [posts.id],
  }),
  channel: one(socialMediaChannels, {
    fields: [postHistory.channelId],
    references: [socialMediaChannels.id],
  }),
  performedBy: one(users, {
    fields: [postHistory.performedById],
    references: [users.id],
  }),
}));
