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