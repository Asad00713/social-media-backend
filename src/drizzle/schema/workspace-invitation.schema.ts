import { pgTable, uuid, timestamp, varchar, pgEnum } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { workspace } from './workspace.schema';
import { users } from './users.schema';

export const memberRoleEnum = pgEnum('member_role', ['ADMIN', 'MEMBER', 'GUEST']);
export const invitationStatusEnum = pgEnum('invitation_status', ['PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED']);

export const workspaceInvitation = pgTable('workspace_invitations', {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspace.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 255 }).notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }), // null if user doesn't exist yet
    role: memberRoleEnum('role').notNull().default('MEMBER'),
    status: invitationStatusEnum('status').notNull().default('PENDING'),
    invitedBy: uuid('invited_by').notNull().references(() => users.id),
    token: varchar('token', { length: 255 }).notNull().unique(), // unique token for invitation link
    expiresAt: timestamp('expires_at').notNull(), // invitation expires after X days
    acceptedAt: timestamp('accepted_at'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
});

export const workspaceInvitationRelations = relations(workspaceInvitation, ({ one }) => ({
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
}));

export type WorkspaceInvitation = typeof workspaceInvitation.$inferSelect;