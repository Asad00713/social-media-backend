import {
  pgTable,
  uuid,
  timestamp,
  varchar,
  boolean,
  text,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users.schema';

export const workspace = pgTable('workspace', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 40 }).notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  logo: text('logo'),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  timezone: text('timezone').notNull().default('UTC'),

  // AI provider preference (null = system default)
  preferredAiProvider: varchar('preferred_ai_provider', { length: 20 }),

  // --- Maestro BYOK (bring your own Anthropic key) ---
  // The workspace's own Anthropic API key, ENCRYPTED at rest (AES-256-GCM via
  // common/utils/encryption.util). Null = use the platform key and bill the
  // workspace's plan credits. Set = the workspace pays Anthropic directly, so
  // Maestro turns are logged but NOT billed against plan credits.
  // Never returned to the client — the API exposes `maestroKeyHint` instead.
  maestroAnthropicKey: text('maestro_anthropic_key'),
  // Last 4 characters of the live key, stored in PLAINTEXT purely so settings
  // can render "sk-ant-…4f2a" without ever decrypting the real key.
  maestroAnthropicKeyHint: varchar('maestro_anthropic_key_hint', { length: 8 }),
  // When the key was last saved/replaced (shown in settings).
  maestroAnthropicKeySetAt: timestamp('maestro_anthropic_key_set_at'),
  // Marks the first-run Maestro wizard as finished, so it runs once, not on
  // every reload. Null = the user has not completed it yet.
  maestroOnboardedAt: timestamp('maestro_onboarded_at'),

  // Workspace suspension
  isActive: boolean('is_active').notNull().default(true),
  suspendedAt: timestamp('suspended_at'),
  suspendedReason: varchar('suspended_reason', { length: 50 }), // non_payment, policy_violation, abuse, manual
  suspendedById: uuid('suspended_by_id'),
  suspensionNote: text('suspension_note'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Reverse of usersRelations.ownedWorkspaces — also powers `with: { owner }`
// queries (e.g. workspace general settings). Without this, Drizzle's relational
// query builder throws "Cannot read properties of undefined (referencedTable)".
export const workspaceRelations = relations(workspace, ({ one }) => ({
  owner: one(users, {
    fields: [workspace.ownerId],
    references: [users.id],
  }),
}));

export type Workspace = typeof workspace.$inferSelect;
export type NewWorkspace = typeof workspace.$inferInsert;
