import { jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { mediaItems } from './media-library.schema';
import { users } from './users.schema';
import { workspace } from './workspace.schema';

/** The seven sliders of the photo editor's Adjust tool, each -100..100. */
export const ADJUST_KEYS = [
  'brightness',
  'contrast',
  'saturation',
  'warmth',
  'highlights',
  'shadows',
  'sharpen',
] as const;
export type AdjustKey = (typeof ADJUST_KEYS)[number];

/** A named set of adjustments the whole workspace can apply. */
export interface AdjustPreset {
  id: string;
  name: string;
  values: Partial<Record<AdjustKey, number>>;
}

/**
 * One brand kit per workspace: text colours, the default watermark logo (a
 * Library image) and the Adjust tool's team presets. No row = empty kit.
 * Migration: drizzle/migrations/0059_brand_kits.sql (hand-written; the
 * jsonb-is-an-array CHECKs live there).
 */
export const workspaceBrandKits = pgTable('workspace_brand_kits', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspace.id, { onDelete: 'cascade' }),
  colors: jsonb('colors')
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  logoMediaId: uuid('logo_media_id').references(() => mediaItems.id, {
    onDelete: 'set null',
  }),
  adjustPresets: jsonb('adjust_presets')
    .$type<AdjustPreset[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  updatedById: uuid('updated_by_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type BrandKitRow = typeof workspaceBrandKits.$inferSelect;
