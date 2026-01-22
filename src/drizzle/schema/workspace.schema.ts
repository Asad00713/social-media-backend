import { pgTable, uuid, timestamp, varchar, boolean, text } from "drizzle-orm/pg-core";
import { users } from "./users.schema";

export const workspace = pgTable('workspace', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 40 }).notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  logo: text('logo'),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  timezone: text("timezone").notNull().default("UTC"),

  // Workspace suspension
  isActive: boolean('is_active').notNull().default(true),
  suspendedAt: timestamp('suspended_at'),
  suspendedReason: varchar('suspended_reason', { length: 50 }), // non_payment, policy_violation, abuse, manual
  suspendedById: uuid('suspended_by_id'),
  suspensionNote: text('suspension_note'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type Workspace = typeof workspace.$inferSelect;
export type NewWorkspace = typeof workspace.$inferInsert;