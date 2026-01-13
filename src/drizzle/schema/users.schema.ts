import {
  pgTable,
  uuid,
  timestamp,
  varchar,
  text,
  boolean,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { workspace } from './workspace.schema';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  name: varchar('name', { length: 255 }),
  password: text('password').notNull(),

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