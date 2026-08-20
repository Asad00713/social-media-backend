import { pgTable, uuid, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users.schema';
import { feedbackTypeEnum } from './feedback.schema';

/**
 * A user closing the feedback prompt without answering.
 *
 * Server-side rather than localStorage: a browser-local dismissal is defeated
 * the moment the user opens a different browser, which would show the prompt
 * again and ignore the cooldown entirely.
 *
 * One row per (user, type), upserted — only the most recent dismissal matters.
 * The `type` column records WHAT was dismissed, but the throttle reads the
 * newest dismissal across all types for the user.
 */
export const feedbackDismissals = pgTable(
  'feedback_dismissals',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    type: feedbackTypeEnum('type').notNull(),

    dismissedAt: timestamp('dismissed_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('feedback_dismissals_user_type_uq').on(
      table.userId,
      table.type,
    ),
  ],
);

export const feedbackDismissalsRelations = relations(
  feedbackDismissals,
  ({ one }) => ({
    user: one(users, {
      fields: [feedbackDismissals.userId],
      references: [users.id],
    }),
  }),
);

export type FeedbackDismissal = typeof feedbackDismissals.$inferSelect;
export type NewFeedbackDismissal = typeof feedbackDismissals.$inferInsert;
