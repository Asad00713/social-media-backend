import {
  pgTable,
  uuid,
  timestamp,
  varchar,
  integer,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users.schema';

/**
 * A one-time code emailed to a super admin before they are allowed to reach
 * the password step of the admin dashboard sign-in.
 *
 * This is deliberately NOT reusing `users.emailVerificationToken`. That column
 * belongs to the email-verification flow, and sharing it would mean an admin
 * signing in silently overwrites a pending verification code — two unrelated
 * features quietly corrupting each other through one column.
 *
 * The code itself is never stored. Only its SHA-256 hash is kept, so a dump of
 * this table hands an attacker nothing usable inside the ten-minute window.
 */
export const adminLoginChallenges = pgTable(
  'admin_login_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // SHA-256 of the 6-digit code. Never the code itself.
    otpHash: varchar('otp_hash', { length: 64 }).notNull(),

    // `withTimezone` matters here, and it is not cosmetic. A bare `timestamp`
    // stores the wall-clock digits with no zone, so a date sent as UTC by Node
    // gets compared against a Postgres `now()` running in the server's local
    // zone. On this machine that is UTC+5, which made every code expire five
    // hours before it was created — every OTP dead on arrival.
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    // Wrong guesses so far. Six digits is a million combinations, which is
    // brute-forceable inside ten minutes without a ceiling on attempts.
    attempts: integer('attempts').default(0).notNull(),

    // Stamped the moment the code is exchanged for a challenge token, so the
    // same code can never be spent twice.
    consumedAt: timestamp('consumed_at', { withTimezone: true }),

    // Kept for the rate limiter: how many codes this address has asked for
    // recently is a question about requests, not about the user.
    requestIp: varchar('request_ip', { length: 45 }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Verification always looks up the newest unconsumed row for one user.
    index('admin_login_challenges_user_created_idx').on(
      table.userId,
      table.createdAt,
    ),
    // Lets the cleanup job drop expired rows without a sequential scan.
    index('admin_login_challenges_expires_idx').on(table.expiresAt),
  ],
);

export const adminLoginChallengesRelations = relations(
  adminLoginChallenges,
  ({ one }) => ({
    user: one(users, {
      fields: [adminLoginChallenges.userId],
      references: [users.id],
    }),
  }),
);

export type AdminLoginChallenge = typeof adminLoginChallenges.$inferSelect;
export type NewAdminLoginChallenge = typeof adminLoginChallenges.$inferInsert;
