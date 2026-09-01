import {
  pgTable,
  pgEnum,
  uuid,
  timestamp,
  varchar,
  text,
  boolean,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { workspace } from './workspace.schema';

// System-level user roles
// USER: Regular user (can create workspaces, manage their own content)
// ADMIN: Platform admin (can manage users, view reports)
// SUPER_ADMIN: Platform owner (full system access, billing, all admin features)
export const USER_ROLES = ['USER', 'ADMIN', 'SUPER_ADMIN'] as const;
export type UserRole = (typeof USER_ROLES)[number];
export const userRoleEnum = pgEnum('user_role', USER_ROLES);

// How Maestro pitches its replies. 'professional' is the pre-existing voice, so
// it is the default and no existing user notices a change.
export const MAESTRO_TONES = ['simple', 'professional', 'detailed'] as const;
export type MaestroTone = (typeof MAESTRO_TONES)[number];
export const maestroToneEnum = pgEnum('maestro_tone', MAESTRO_TONES);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  name: varchar('name', { length: 255 }),
  password: text('password').notNull(),

  // System-level role (USER or SUPER_ADMIN)
  role: userRoleEnum('role').default('USER').notNull(),

  // Email verification
  isEmailVerified: boolean('is_email_verified').default(false).notNull(),
  emailVerificationToken: varchar('email_verification_token', { length: 255 }),
  emailVerificationTokenExpiresAt: timestamp(
    'email_verification_token_expires_at',
  ),

  // Password reset
  passwordResetToken: varchar('password_reset_token', { length: 255 }),
  passwordResetTokenExpiresAt: timestamp('password_reset_token_expires_at'),

  // Last accessed workspace for redirect on login
  lastAccessedWorkspaceId: uuid('last_accessed_workspace_id'),

  // Stamped when the user finishes the multi-step onboarding flow
  // (workspace → persona → invite → connect). Null while onboarding is
  // in progress. Source of truth for route-guard gating so the decision
  // is per-user (server-side) instead of per-browser (localStorage).
  onboardingCompletedAt: timestamp('onboarding_completed_at'),

  // Account suspension
  isActive: boolean('is_active').default(true).notNull(),
  suspendedAt: timestamp('suspended_at'),
  suspendedReason: varchar('suspended_reason', { length: 50 }), // non_payment, policy_violation, abuse, manual
  suspendedById: uuid('suspended_by_id'),
  suspensionNote: text('suspension_note'),

  // Last login tracking
  lastLoginAt: timestamp('last_login_at'),
  // Where the last session signed in from. The IP is captured at auth time;
  // country/countryCode are resolved from it (best-effort, may lag or be null).
  lastLoginIp: varchar('last_login_ip', { length: 45 }), // fits IPv6
  country: varchar('country', { length: 100 }),
  countryCode: varchar('country_code', { length: 2 }), // ISO 3166-1 alpha-2

  // How Maestro should pitch its replies to THIS user. Per-user, not
  // per-workspace: one workspace holds people of very different technical
  // comfort, so a workspace-wide setting would let one member's choice change
  // the assistant for everyone else. Server-side rather than localStorage for
  // the same reason as onboardingCompletedAt above -- the person who most needs
  // 'simple' is the least likely to re-pick it on every new device.
  maestroTone: maestroToneEnum('maestro_tone')
    .default('professional')
    .notNull(),

  // Inactivity email tracking
  inactivityEmail15DaysSentAt: timestamp('inactivity_email_15_days_sent_at'),
  inactivityEmail25DaysSentAt: timestamp('inactivity_email_25_days_sent_at'),
  inactivityEmail30DaysSentAt: timestamp('inactivity_email_30_days_sent_at'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Relations will be defined after importing other schemas
// export const usersRelations = relations(users, ({ many }) => ({
//   socialAccounts: many('socialAccounts'),
//   posts: many('posts'),
// }));

// Type exports
export const usersRelations = relations(users, ({ many }) => ({
  ownedWorkspaces: many(workspace), // Workspaces this user owns
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
