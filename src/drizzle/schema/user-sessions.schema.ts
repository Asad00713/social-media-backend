import {
  char,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.schema';

export const DEVICE_TYPES = ['desktop', 'mobile', 'tablet', 'unknown'] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

/**
 * One row per sign-in. Access and refresh tokens carry its `id` as `sid`;
 * a revoked row (`revokedAt`) or an idle one (`expiresAt` passed) ends the
 * session. Each refresh moves `lastUsedAt` and pushes `expiresAt` 30 days
 * out. `ip` is never sent to the browser.
 * Migration: drizzle/migrations/0098_user_sessions.sql (hand-written).
 */
export const userSessions = pgTable(
  'user_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceHash: char('device_hash', { length: 64 }),
    label: varchar('label', { length: 120 }).notNull(),
    deviceType: text('device_type', { enum: DEVICE_TYPES }).notNull(),
    ip: varchar('ip', { length: 45 }),
    country: varchar('country', { length: 100 }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('user_sessions_user_live_idx')
      .on(t.userId)
      .where(sql`${t.revokedAt} IS NULL`),
    // Prune of old rows on sign-in and the users ON DELETE CASCADE.
    index('user_sessions_user_idx').on(t.userId),
  ],
);

export type UserSession = typeof userSessions.$inferSelect;
