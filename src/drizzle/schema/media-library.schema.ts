import {
  pgTable,
  uuid,
  text,
  timestamp,
  varchar,
  jsonb,
  index,
  integer,
  bigint,
  boolean,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users.schema';
import { workspace } from './workspace.schema';

// =============================================================================
// Media Types
// =============================================================================

export const MEDIA_LIBRARY_TYPES = [
  'image',
  'video',
  'gif',
  'template',
  'document',
  'text_snippet',
  'link',
] as const;

export type MediaLibraryType = (typeof MEDIA_LIBRARY_TYPES)[number];

// =============================================================================
// Media Categories - User-created categories per type
// =============================================================================

export const mediaCategories = pgTable(
  'media_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),

    // Category details
    name: varchar('name', { length: 100 }).notNull(),
    description: text('description'),
    type: varchar('type', { length: 50 }).$type<MediaLibraryType>().notNull(),
    color: varchar('color', { length: 20 }), // Hex color for UI
    icon: varchar('icon', { length: 50 }), // Icon name for UI

    // Ordering
    displayOrder: integer('display_order').default(0),

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('media_categories_workspace_id_idx').on(table.workspaceId),
    index('media_categories_type_idx').on(table.type),
    index('media_categories_workspace_type_idx').on(
      table.workspaceId,
      table.type,
    ),
  ],
);

// =============================================================================
// Media Items - Images, Videos, GIFs, Documents
// =============================================================================

export const mediaItems = pgTable(
  'media_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),

    uploadedById: uuid('uploaded_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    categoryId: uuid('category_id').references(() => mediaCategories.id, {
      onDelete: 'set null',
    }),

    // Type
    type: varchar('type', { length: 50 }).$type<MediaLibraryType>().notNull(),

    // File details
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    fileUrl: text('file_url').notNull(),
    thumbnailUrl: text('thumbnail_url'),
    mimeType: varchar('mime_type', { length: 100 }),
    fileSize: bigint('file_size', { mode: 'number' }), // in bytes

    // Dimensions (for images/videos)
    width: integer('width'),
    height: integer('height'),
    duration: integer('duration'), // For videos, in seconds

    // Cloudinary specific
    cloudinaryPublicId: varchar('cloudinary_public_id', { length: 255 }),
    cloudinaryAssetId: varchar('cloudinary_asset_id', { length: 255 }),

    // Organization
    tags: jsonb('tags').$type<string[]>().default([]),
    isStarred: boolean('is_starred').default(false),

    // Usage tracking
    usageCount: integer('usage_count').default(0),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),

    // Soft delete (recycle bin)
    isDeleted: boolean('is_deleted').default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedById: uuid('deleted_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('media_items_workspace_id_idx').on(table.workspaceId),
    index('media_items_category_id_idx').on(table.categoryId),
    index('media_items_type_idx').on(table.type),
    index('media_items_uploaded_by_id_idx').on(table.uploadedById),
    index('media_items_is_deleted_idx').on(table.isDeleted),
    index('media_items_is_starred_idx').on(table.isStarred),
    index('media_items_created_at_idx').on(table.createdAt),
    index('media_items_workspace_type_idx').on(table.workspaceId, table.type),
    index('media_items_workspace_deleted_idx').on(
      table.workspaceId,
      table.isDeleted,
    ),
  ],
);

// =============================================================================
// Media Templates - Reusable post templates with placeholders
// =============================================================================

export const TEMPLATE_TYPES = [
  'post',
  'story',
  'reel',
  'carousel',
] as const;

export type TemplateType = (typeof TEMPLATE_TYPES)[number];

export interface TemplateMediaSlot {
  id: string;
  label: string;
  required: boolean;
  acceptedTypes: ('image' | 'video' | 'gif')[];
}

export interface TemplateContent {
  text: string; // Can contain {{placeholders}}
  mediaSlots: TemplateMediaSlot[];
  hashtags: string[];
  defaultCaption?: string;
}

export const mediaTemplates = pgTable(
  'media_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),

    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    categoryId: uuid('category_id').references(() => mediaCategories.id, {
      onDelete: 'set null',
    }),

    // Template details
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    templateType: varchar('template_type', { length: 50 })
      .$type<TemplateType>()
      .notNull()
      .default('post'),

    // Supported platforms
    platforms: jsonb('platforms').$type<string[]>().default([]),

    // Template content structure
    content: jsonb('content').$type<TemplateContent>().notNull(),

    // Preview
    thumbnailUrl: text('thumbnail_url'),

    // Organization
    tags: jsonb('tags').$type<string[]>().default([]),
    isStarred: boolean('is_starred').default(false),

    // Usage tracking
    usageCount: integer('usage_count').default(0),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),

    // Soft delete (recycle bin)
    isDeleted: boolean('is_deleted').default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedById: uuid('deleted_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('media_templates_workspace_id_idx').on(table.workspaceId),
    index('media_templates_category_id_idx').on(table.categoryId),
    index('media_templates_template_type_idx').on(table.templateType),
    index('media_templates_created_by_id_idx').on(table.createdById),
    index('media_templates_is_deleted_idx').on(table.isDeleted),
    index('media_templates_created_at_idx').on(table.createdAt),
  ],
);

// =============================================================================
// Text Snippets - Saved captions, hashtag sets, CTAs
// =============================================================================

export const TEXT_SNIPPET_TYPES = [
  'caption',
  'hashtags',
  'cta',
  'bio',
  'other',
] as const;

export type TextSnippetType = (typeof TEXT_SNIPPET_TYPES)[number];

export const textSnippets = pgTable(
  'text_snippets',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),

    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    categoryId: uuid('category_id').references(() => mediaCategories.id, {
      onDelete: 'set null',
    }),

    // Snippet details
    name: varchar('name', { length: 255 }).notNull(),
    snippetType: varchar('snippet_type', { length: 50 })
      .$type<TextSnippetType>()
      .notNull()
      .default('caption'),
    content: text('content').notNull(),

    // Organization
    tags: jsonb('tags').$type<string[]>().default([]),
    isStarred: boolean('is_starred').default(false),

    // Usage tracking
    usageCount: integer('usage_count').default(0),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),

    // Soft delete (recycle bin)
    isDeleted: boolean('is_deleted').default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedById: uuid('deleted_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('text_snippets_workspace_id_idx').on(table.workspaceId),
    index('text_snippets_category_id_idx').on(table.categoryId),
    index('text_snippets_snippet_type_idx').on(table.snippetType),
    index('text_snippets_created_by_id_idx').on(table.createdById),
    index('text_snippets_is_deleted_idx').on(table.isDeleted),
    index('text_snippets_created_at_idx').on(table.createdAt),
  ],
);

// =============================================================================
// Saved Links - URLs with metadata
// =============================================================================

export const savedLinks = pgTable(
  'saved_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),

    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    categoryId: uuid('category_id').references(() => mediaCategories.id, {
      onDelete: 'set null',
    }),

    // Link details
    name: varchar('name', { length: 255 }).notNull(),
    url: text('url').notNull(),
    description: text('description'),

    // Link preview metadata (fetched from URL)
    previewTitle: varchar('preview_title', { length: 500 }),
    previewDescription: text('preview_description'),
    previewImageUrl: text('preview_image_url'),
    previewSiteName: varchar('preview_site_name', { length: 255 }),

    // Organization
    tags: jsonb('tags').$type<string[]>().default([]),
    isStarred: boolean('is_starred').default(false),

    // Usage tracking
    usageCount: integer('usage_count').default(0),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),

    // Soft delete (recycle bin)
    isDeleted: boolean('is_deleted').default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedById: uuid('deleted_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('saved_links_workspace_id_idx').on(table.workspaceId),
    index('saved_links_category_id_idx').on(table.categoryId),
    index('saved_links_created_by_id_idx').on(table.createdById),
    index('saved_links_is_deleted_idx').on(table.isDeleted),
    index('saved_links_created_at_idx').on(table.createdAt),
  ],
);

// =============================================================================
// Relations
// =============================================================================

export const mediaCategoriesRelations = relations(
  mediaCategories,
  ({ one, many }) => ({
    workspace: one(workspace, {
      fields: [mediaCategories.workspaceId],
      references: [workspace.id],
    }),
    mediaItems: many(mediaItems),
    templates: many(mediaTemplates),
    textSnippets: many(textSnippets),
    savedLinks: many(savedLinks),
  }),
);

export const mediaItemsRelations = relations(mediaItems, ({ one }) => ({
  workspace: one(workspace, {
    fields: [mediaItems.workspaceId],
    references: [workspace.id],
  }),
  uploadedBy: one(users, {
    fields: [mediaItems.uploadedById],
    references: [users.id],
  }),
  category: one(mediaCategories, {
    fields: [mediaItems.categoryId],
    references: [mediaCategories.id],
  }),
  deletedBy: one(users, {
    fields: [mediaItems.deletedById],
    references: [users.id],
  }),
}));

export const mediaTemplatesRelations = relations(mediaTemplates, ({ one }) => ({
  workspace: one(workspace, {
    fields: [mediaTemplates.workspaceId],
    references: [workspace.id],
  }),
  createdBy: one(users, {
    fields: [mediaTemplates.createdById],
    references: [users.id],
  }),
  category: one(mediaCategories, {
    fields: [mediaTemplates.categoryId],
    references: [mediaCategories.id],
  }),
  deletedBy: one(users, {
    fields: [mediaTemplates.deletedById],
    references: [users.id],
  }),
}));

export const textSnippetsRelations = relations(textSnippets, ({ one }) => ({
  workspace: one(workspace, {
    fields: [textSnippets.workspaceId],
    references: [workspace.id],
  }),
  createdBy: one(users, {
    fields: [textSnippets.createdById],
    references: [users.id],
  }),
  category: one(mediaCategories, {
    fields: [textSnippets.categoryId],
    references: [mediaCategories.id],
  }),
  deletedBy: one(users, {
    fields: [textSnippets.deletedById],
    references: [users.id],
  }),
}));

export const savedLinksRelations = relations(savedLinks, ({ one }) => ({
  workspace: one(workspace, {
    fields: [savedLinks.workspaceId],
    references: [workspace.id],
  }),
  createdBy: one(users, {
    fields: [savedLinks.createdById],
    references: [users.id],
  }),
  category: one(mediaCategories, {
    fields: [savedLinks.categoryId],
    references: [mediaCategories.id],
  }),
  deletedBy: one(users, {
    fields: [savedLinks.deletedById],
    references: [users.id],
  }),
}));

// =============================================================================
// Type exports for inserts
// =============================================================================

export type NewMediaCategory = typeof mediaCategories.$inferInsert;
export type MediaCategory = typeof mediaCategories.$inferSelect;

export type NewMediaItem = typeof mediaItems.$inferInsert;
export type MediaLibraryItem = typeof mediaItems.$inferSelect;

export type NewMediaTemplate = typeof mediaTemplates.$inferInsert;
export type MediaTemplate = typeof mediaTemplates.$inferSelect;

export type NewTextSnippet = typeof textSnippets.$inferInsert;
export type TextSnippet = typeof textSnippets.$inferSelect;

export type NewSavedLink = typeof savedLinks.$inferInsert;
export type SavedLink = typeof savedLinks.$inferSelect;
