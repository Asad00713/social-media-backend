import {
  pgTable,
  pgEnum,
  uuid,
  timestamp,
  text,
  integer,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users.schema';

// Feedback approval status
export const FEEDBACK_STATUS = ['pending', 'approved', 'rejected'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUS)[number];
export const feedbackStatusEnum = pgEnum('feedback_status', FEEDBACK_STATUS);

export const feedback = pgTable('feedback', {
  id: uuid('id').primaryKey().defaultRandom(),

  // User who submitted the feedback
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

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
});

// Relations
export const feedbackRelations = relations(feedback, ({ one }) => ({
  user: one(users, {
    fields: [feedback.userId],
    references: [users.id],
  }),
}));

export type Feedback = typeof feedback.$inferSelect;
export type NewFeedback = typeof feedback.$inferInsert;
