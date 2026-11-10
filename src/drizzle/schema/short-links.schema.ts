import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { posts } from './posts.schema';
import { users } from './users.schema';
import { workspace } from './workspace.schema';

/** Longest target URL, in characters. Mirrored by a CHECK in the migration. */
export const SHORT_LINK_TARGET_MAX = 2048;

/**
 * A shortened URL (the composer Link panel's "Shorten the link" row), served
 * by the public `GET /l/:code` redirect. One row per workspace and target
 * URL: shortening the same address twice returns the same code.
 * Migration: drizzle/migrations/0061_short_links.sql (hand-written; the
 * code-format, http(s)-only and clicks CHECKs live there).
 */
export const shortLinks = pgTable(
  'short_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    targetUrl: text('target_url').notNull(),
    postId: uuid('post_id').references(() => posts.id, {
      onDelete: 'set null',
    }),
    createdById: uuid('created_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    clicks: integer('clicks').notNull().default(0),
    lastClickedAt: timestamp('last_clicked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('short_links_code_key').on(t.code),
    uniqueIndex('short_links_workspace_id_target_url_key').on(
      t.workspaceId,
      t.targetUrl,
    ),
    index('short_links_workspace_id_created_at_idx').on(
      t.workspaceId,
      t.createdAt,
    ),
    index('short_links_post_id_idx')
      .on(t.postId)
      .where(sql`${t.postId} IS NOT NULL`),
  ],
);

export type ShortLinkRow = typeof shortLinks.$inferSelect;
