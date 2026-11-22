import {
  char,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.schema';

/**
 * Two-step sign-in tables (the users and known_devices columns live in their
 * own schema files).
 * Migration: drizzle/migrations/0099_two_factor.sql (hand-written).
 */

/**
 * Ten single-use backup codes per person with 2FA on. Only the HMAC-SHA256
 * of the normalised code under `MFA_CODE_PEPPER` is stored; `usedAt` is set
 * by the one UPDATE that spends it.
 */
export const userBackupCodes = pgTable(
  'user_backup_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: char('code_hash', { length: 64 }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('user_backup_codes_user_unused_idx')
      .on(t.userId)
      .where(sql`${t.usedAt} IS NULL`),
  ],
);

export type UserBackupCode = typeof userBackupCodes.$inferSelect;

/**
 * 'mfa': the step between a correct first factor and the code.
 * 'admin_email': the super-admin emailed-code step, made single-use.
 */
export const CHALLENGE_PURPOSES = ['mfa', 'admin_email'] as const;
export type ChallengePurpose = (typeof CHALLENGE_PURPOSES)[number];

/**
 * A short-lived sign-in challenge, bound to a signed token by `id` and
 * consumed at most once (`consumedAt`). `attempts` counts wrong codes;
 * `deviceHash` is the sha256 of the browser's `sd_device` cookie when the
 * challenge was made, so a successful code can trust that browser.
 */
export const loginChallenges = pgTable(
  'login_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose', { enum: CHALLENGE_PURPOSES }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    deviceHash: char('device_hash', { length: 64 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('login_challenges_user_idx').on(t.userId)],
);

export type LoginChallenge = typeof loginChallenges.$inferSelect;
