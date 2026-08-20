import {
  pgTable,
  pgEnum,
  uuid,
  timestamp,
  text,
  integer,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users.schema';

// Feedback approval status
export const FEEDBACK_STATUS = ['pending', 'approved', 'rejected'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUS)[number];
export const feedbackStatusEnum = pgEnum('feedback_status', FEEDBACK_STATUS);

// What the review is about. `app` = the product overall; `maestro` = the AI
// assistant. Distinct from Maestro's per-message 👍/👎, which lives in the
// maestro module and answers a different question.
export const FEEDBACK_TYPE = ['app', 'maestro'] as const;
export type FeedbackType = (typeof FEEDBACK_TYPE)[number];
export const feedbackTypeEnum = pgEnum('feedback_type', FEEDBACK_TYPE);

export const feedback = pgTable(
  'feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // User who submitted the feedback
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // Which surface this review is about
    type: feedbackTypeEnum('type').default('app').notNull(),

    // Rating (1-5 stars)
    rating: integer('rating').notNull(),

    // Comment/review text
    comment: text('comment'),

    // Moderation status
    status: feedbackStatusEnum('status').default('pending').notNull(),

    // Admin notes (for internal use)
    adminNotes: text('admin_notes'),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    // One review per user per type — a user may rate the app and Maestro
    // separately. Enforced in the DB, not just in the service, so concurrent
    // submits cannot both slip through the read-then-write check.
    uniqueIndex('feedback_user_id_type_idx').on(table.userId, table.type),
  ],
);

// Relations
export const feedbackRelations = relations(feedback, ({ one }) => ({
  user: one(users, {
    fields: [feedback.userId],
    references: [users.id],
  }),
}));

export type Feedback = typeof feedback.$inferSelect;
export type NewFeedback = typeof feedback.$inferInsert;
