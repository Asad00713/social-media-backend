import {
  pgTable,
  uuid,
  timestamp,
  varchar,
  boolean,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.schema';
import { workspace } from './workspace.schema';

export const INBOX_DEFAULT_LATER = [
  'later_today',
  'tomorrow',
  'next_week',
] as const;
export type InboxDefaultLater = (typeof INBOX_DEFAULT_LATER)[number];

export const INBOX_NOTIFY = [
  'assigned_and_mentions',
  'everything',
  'nothing',
] as const;
export type InboxNotify = (typeof INBOX_NOTIFY)[number];

/** inbox_user_settings — per user, per workspace preferences (0050). */
export const inboxUserSettings = pgTable(
  'inbox_user_settings',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    markDoneOnReply: boolean('mark_done_on_reply').notNull().default(true),
    defaultLater: varchar('default_later', { length: 16 })
      .$type<InboxDefaultLater>()
      .notNull()
      .default('tomorrow'),
    notify: varchar('notify', { length: 24 })
      .$type<InboxNotify>()
      .notNull()
      .default('assigned_and_mentions'),
    replyWindowWarnings: boolean('reply_window_warnings')
      .notNull()
      .default(true),
    aiQuickReplies: boolean('ai_quick_replies').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.workspaceId] }),
    defaultLaterChk: check(
      'inbox_user_settings_default_later_chk',
      sql`${t.defaultLater} IN ('later_today', 'tomorrow', 'next_week')`,
    ),
    notifyChk: check(
      'inbox_user_settings_notify_chk',
      sql`${t.notify} IN ('assigned_and_mentions', 'everything', 'nothing')`,
    ),
  }),
);

export type InboxUserSettingsRow = typeof inboxUserSettings.$inferSelect;
export type NewInboxUserSettingsRow = typeof inboxUserSettings.$inferInsert;
