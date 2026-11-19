import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { posts } from './posts.schema';
import { users } from './users.schema';
import { workspace } from './workspace.schema';

/**
 * The label palette, in the order colours are handed out. Mirrored by a
 * CHECK in 0094.
 */
export const LABEL_COLORS = [
  'blue',
  'orange',
  'green',
  'purple',
  'pink',
  'teal',
  'red',
  'grey',
] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];

/** Longest label name and description, in characters (varchar lengths in 0094). */
export const LABEL_NAME_MAX = 40;
export const LABEL_DESCRIPTION_MAX = 120;

/**
 * A workspace's label catalogue. Deleting is soft (`deleted_at`) so the
 * 10-second undo can restore a label; the name is unique per workspace,
 * case-insensitively, among live labels only.
 * Migration: drizzle/migrations/0094_workspace_labels.sql (hand-written; the
 * colour CHECK lives there).
 */
export const workspaceLabels = pgTable(
  'workspace_labels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: LABEL_NAME_MAX }).notNull(),
    color: text('color').$type<LabelColor>().notNull(),
    description: varchar('description', { length: LABEL_DESCRIPTION_MAX }),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('workspace_labels_name_uq')
      .on(t.workspaceId, sql`lower(${t.name})`)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

/** Which labels a post carries. Rows cascade with the post or the label. */
export const postLabels = pgTable(
  'post_labels',
  {
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    labelId: uuid('label_id')
      .notNull()
      .references(() => workspaceLabels.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.postId, t.labelId] }),
    index('post_labels_label_idx').on(t.labelId),
  ],
);

export type WorkspaceLabel = typeof workspaceLabels.$inferSelect;
export type PostLabel = typeof postLabels.$inferSelect;
