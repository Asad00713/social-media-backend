import {
  pgTable,
  uuid,
  timestamp,
  varchar,
  pgEnum,
  text,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { workspace } from './workspace.schema';
import { users } from './users.schema';

export const memberRoleEnum = pgEnum('member_role', [
  'ADMIN',
  'MEMBER',
  'GUEST',
]);
export const invitationStatusEnum = pgEnum('invitation_status', [
  'PENDING',
  'ACCEPTED',
  'REJECTED',
  'EXPIRED',
  // A member who was removed (0080). The row is kept so the removal can be
  // undone for a short while; nothing reads REMOVED as a member or invite.
  'REMOVED',
]);

export const workspaceInvitation = pgTable('workspace_invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'cascade' }),
  email: varchar('email', { length: 255 }).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }), // null if user doesn't exist yet
  role: memberRoleEnum('role').notNull().default('MEMBER'),
  status: invitationStatusEnum('status').notNull().default('PENDING'),
  // NULL once the inviter's account is deleted (0095, SET NULL); the
  // invitation itself is kept.
  invitedBy: uuid('invited_by').references(() => users.id, {
    onDelete: 'set null',
  }),
  token: varchar('token', { length: 255 }).notNull().unique(), // unique token for invitation link
  expiresAt: timestamp('expires_at').notNull(), // invitation expires after X days
  acceptedAt: timestamp('accepted_at'),
  // Set when the member is removed (status REMOVED). removedBy equal to
  // userId means they left on their own, which is never restorable.
  removedAt: timestamp('removed_at', { withTimezone: true }),
  removedBy: uuid('removed_by').references(() => users.id, {
    onDelete: 'set null',
  }),
  // Optional personal note from the inviter, shown in the invitation email (0093).
  message: text('message'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const workspaceInvitationRelations = relations(
  workspaceInvitation,
  ({ one }) => ({
    workspace: one(workspace, {
      fields: [workspaceInvitation.workspaceId],
      references: [workspace.id],
    }),
    user: one(users, {
      fields: [workspaceInvitation.userId],
      references: [users.id],
    }),
    inviter: one(users, {
      fields: [workspaceInvitation.invitedBy],
      references: [users.id],
    }),
  }),
);

export type WorkspaceInvitation = typeof workspaceInvitation.$inferSelect;
