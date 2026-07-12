import { pgTable, uuid, varchar, text, timestamp } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users.schema';
import { workspace } from './workspace.schema';

// =============================================================================
// Canva Connections - server-side Canva OAuth tokens, one per workspace
// =============================================================================
// Security note: unlike `src/canva`'s legacy browser-token flow (tokens
// round-tripped through the OAuth redirect URL and every request body), this
// table backs the secure composer integration — tokens are persisted here and
// only ever used server-side (see CanvaConnectionService.getValidAccessToken).
export const canvaConnections = pgTable('canva_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'cascade' })
    .unique(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  canvaUserId: varchar('canva_user_id', { length: 255 }),
  displayName: varchar('display_name', { length: 255 }),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token').notNull(),
  tokenExpiresAt: timestamp('token_expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const canvaConnectionsRelations = relations(
  canvaConnections,
  ({ one }) => ({
    workspace: one(workspace, {
      fields: [canvaConnections.workspaceId],
      references: [workspace.id],
    }),
    user: one(users, {
      fields: [canvaConnections.userId],
      references: [users.id],
    }),
  }),
);

export type CanvaConnection = typeof canvaConnections.$inferSelect;
export type NewCanvaConnection = typeof canvaConnections.$inferInsert;
