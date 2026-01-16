import {
  pgTable,
  pgEnum,
  uuid,
  timestamp,
  text,
  boolean,
  varchar,
  jsonb,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users.schema';

// Notification types
export const NOTIFICATION_TYPES = [
  // Auth & Account
  'email_verified',
  'password_changed',
  'new_login',
  // Workspace
  'workspace_invitation',
  'invitation_accepted',
  'invitation_rejected',
  'member_removed',
  // Billing
  'payment_successful',
  'payment_failed',
  'subscription_expiring',
  'plan_changed',
  // Social Media Channels
  'channel_connected',
  'channel_disconnected',
  'token_expired',
  // Posts
  'post_published',
  'post_failed',
  'post_scheduled_reminder',
  // Drip Campaigns
  'campaign_started',
  'campaign_completed',
  'campaign_post_failed',
  // Admin
  'new_user_registered',
  'new_feedback_submitted',
  // General
  'system_announcement',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export const notificationTypeEnum = pgEnum('notification_type', NOTIFICATION_TYPES);

// Notification priority
export const NOTIFICATION_PRIORITIES = ['low', 'medium', 'high'] as const;
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];
export const notificationPriorityEnum = pgEnum('notification_priority', NOTIFICATION_PRIORITIES);

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),

  // User who receives the notification
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  // Notification content
  type: notificationTypeEnum('type').notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  message: text('message').notNull(),
  priority: notificationPriorityEnum('priority').default('medium').notNull(),

  // Additional data (e.g., workspaceId, channelId, postId, etc.)
  metadata: jsonb('metadata'),

  // Action link (optional - where to redirect when clicked)
  actionUrl: text('action_url'),

  // Read status
  isRead: boolean('is_read').default(false).notNull(),
  readAt: timestamp('read_at'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Relations
export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, {
    fields: [notifications.userId],
    references: [users.id],
  }),
}));

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
