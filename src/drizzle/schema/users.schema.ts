import { pgTable, uuid, timestamp, varchar, text } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { workspace } from './workspace.schema';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  name: varchar('name', { length: 255 }),
  password: text('password').notNull(),
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