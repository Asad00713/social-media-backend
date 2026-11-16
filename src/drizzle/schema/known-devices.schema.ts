import {
  char,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from './users.schema';

/**
 * The browsers a person has signed in from, keyed by the sha256 of the
 * `sd_device` cookie. A new row for a person who already has one sends the
 * A6 "new sign-in" email. `label` is the parsed browser ('Chrome on
 * Windows'), never the raw user agent; no IP address is stored.
 * Migration: drizzle/migrations/0072_known_devices.sql (hand-written).
 */
export const knownDevices = pgTable(
  'known_devices',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceHash: char('device_hash', { length: 64 }).notNull(),
    label: varchar('label', { length: 120 }).notNull(),
    country: varchar('country', { length: 100 }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.deviceHash] })],
);

export type KnownDeviceRow = typeof knownDevices.$inferSelect;
