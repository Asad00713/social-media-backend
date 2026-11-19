import {
  pgTable,
  pgEnum,
  uuid,
  timestamp,
  varchar,
  text,
  boolean,
  integer,
  jsonb,
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

// Who the person posts for, asked once in onboarding step 1. It picks the
// copy and Home cards for an agency ("My clients") vs a single brand.
// Nullable: everyone who signed up before the question existed has no answer.
export const USER_USE_CASES = ['own_brand', 'clients'] as const;
export type UserUseCase = (typeof USER_USE_CASES)[number];
export const userUseCaseEnum = pgEnum('user_use_case', USER_USE_CASES);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  name: varchar('name', { length: 255 }),
  // Null for accounts created through Google sign-in. They can set one later
  // from Profile or "Forgot password?", which work the same for them.
  password: text('password'),

  // Profile picture, stored in R2 and referenced by its public URL. Null means
  // the UI falls back to initials — which every avatar does while loading, so
  // an absent picture is a normal state rather than a missing one.
  avatarUrl: text('avatar_url'),

  // The colour behind those initials, chosen once at sign-up and then fixed.
  //
  // Stored rather than derived from the id at render time: a derived colour
  // has to be computed identically everywhere it appears, and the day someone
  // changes the palette or the hash, every user's colour changes with it. A
  // person's avatar is how colleagues recognise them in a list — it should be
  // as stable as their name.
  //
  // Holds a palette KEY ('amber', 'violet'), not a hex value, so light and
  // dark themes can render the same identity differently. See AVATAR_COLORS.
  avatarColor: varchar('avatar_color', { length: 20 }),

  // System-level role (USER or SUPER_ADMIN)
  role: userRoleEnum('role').default('USER').notNull(),

  // Email verification
  isEmailVerified: boolean('is_email_verified').default(false).notNull(),
  emailVerificationToken: varchar('email_verification_token', {
    length: 255,
  }),
  emailVerificationTokenExpiresAt: timestamp(
    'email_verification_token_expires_at',
  ),
  // Wrong guesses against the current signup code. Six digits is a million
  // combinations — brute-forceable inside ten minutes without a ceiling.
  // Reset to 0 whenever a new code is issued.
  emailVerificationAttempts: integer('email_verification_attempts')
    .default(0)
    .notNull(),

  // Password reset
  passwordResetToken: varchar('password_reset_token', { length: 255 }),
  passwordResetTokenExpiresAt: timestamp('password_reset_token_expires_at'),

  // Every token issued before this second is refused (migration 0070): set by
  // a password change or reset and by the "This wasn't me" security link.
  sessionsRevokedAt: timestamp('sessions_revoked_at', { withTimezone: true }),

  // An email change waiting for its code (migration 0071): the new address,
  // the sha256 of the code mailed to it, when the code expires, and the wrong
  // guesses so far. `email` itself changes only when the code comes back.
  pendingEmail: varchar('pending_email', { length: 255 }),
  pendingEmailCodeHash: varchar('pending_email_code_hash', { length: 64 }),
  pendingEmailExpiresAt: timestamp('pending_email_expires_at', {
    withTimezone: true,
  }),
  pendingEmailAttempts: integer('pending_email_attempts').default(0).notNull(),
  // When the sign-in email last changed, by a confirm or a revert (migration
  // 0073). A new change waits 7 days, so A4's revert link stays usable.
  emailChangedAt: timestamp('email_changed_at', { withTimezone: true }),

  // Last accessed workspace for redirect on login
  lastAccessedWorkspaceId: uuid('last_accessed_workspace_id'),

  // Google's stable account id (`sub`). Matched before email, so a user who
  // changes the address on their Google account still reaches this row.
  googleSub: varchar('google_sub', { length: 255 }).unique(),

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

  // Account settings (migration 0090).
  // The Preferences page: only keys the person has chosen, so {} means "all
  // defaults". Shape and allowed values are enforced by the preferences DTO.
  preferences: jsonb('preferences')
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  // When the password last changed (change or reset); null if never changed.
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
  // "Pause notifications": until this instant only failed posts and security
  // alerts are sent. Null or in the past means not paused.
  notificationsPausedUntil: timestamp('notifications_paused_until', {
    withTimezone: true,
  }),
  // Account soft delete: set when the account is deleted and anonymised.
  deletedAt: timestamp('deleted_at', { withTimezone: true }),

  // How Maestro should pitch its replies to THIS user. Per-user, not
  // per-workspace: one workspace holds people of very different technical
  // comfort, so a workspace-wide setting would let one member's choice change
  // the assistant for everyone else. Server-side rather than localStorage for
  // the same reason as onboardingCompletedAt above -- the person who most needs
  // 'simple' is the least likely to re-pick it on every new device.
  maestroTone: maestroToneEnum('maestro_tone')
    .default('professional')
    .notNull(),

  useCase: userUseCaseEnum('use_case'),

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
