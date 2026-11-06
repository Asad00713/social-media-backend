import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { posts } from './posts.schema';
import { users } from './users.schema';
import { workspace } from './workspace.schema';

/** Longest comment, in characters. Mirrored by a CHECK in the migration. */
export const POST_COMMENT_MAX = 2000;

/**
 * A team comment on a post (the composer's "Comments" row). One row per
 * comment; `resolved_at` is set when someone marks it resolved.
 * Migration: drizzle/migrations/0058_post_comments.sql (hand-written; the
 * body-length CHECK lives there).
 */
export const postComments = pgTable(
  'post_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    index('post_comments_post_id_created_at_idx').on(t.postId, t.createdAt),
  ],
);

export type PostCommentRow = typeof postComments.$inferSelect;
