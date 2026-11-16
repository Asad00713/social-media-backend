import { pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';

/**
 * Addresses that hard-bounced or complained, written by the Resend webhook.
 * `email` is stored lowercased (a CHECK in the SQL enforces it); the reason
 * CHECK ('bounced' | 'complained') also lives in the SQL only.
 * Migration: drizzle/migrations/0069_email_suppressions.sql (hand-written).
 */
export const emailSuppressions = pgTable('email_suppressions', {
  email: varchar('email', { length: 255 }).primaryKey(),
  reason: varchar('reason', { length: 16 }).notNull(),
  resendEmailId: varchar('resend_email_id', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type EmailSuppressionRow = typeof emailSuppressions.$inferSelect;
