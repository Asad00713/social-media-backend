import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './users.schema';
import { workspace } from './workspace.schema';

/**
 * Channels a user can talk to Maestro FROM (the bridge), and Maestro can notify
 * them ON. One external identity (Telegram user id / WhatsApp wa_id / email) maps
 * to exactly one Schedura user — `(channel, externalId)` is globally unique. This
 * is the central-bot bridge identity; it is separate from per-workspace inbox bots.
 */
export type MaestroBridgeChannel = 'telegram' | 'whatsapp' | 'email';
export type MaestroLinkStatus = 'active' | 'revoked';

export const maestroChannelLinks = pgTable(
  'maestro_channel_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: varchar('channel', { length: 16 })
      .$type<MaestroBridgeChannel>()
      .notNull(),
    /** Telegram user id / WhatsApp wa_id (phone) / email address. */
    externalId: varchar('external_id', { length: 128 }).notNull(),
    displayName: text('display_name'),
    /** Which workspace Maestro acts on by default for this link. */
    defaultWorkspaceId: uuid('default_workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    /** The Maestro conversation backing this bridge (chatbot tables). */
    conversationId: uuid('conversation_id'),
    status: varchar('status', { length: 16 })
      .$type<MaestroLinkStatus>()
      .notNull()
      .default('active'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    linkedAt: timestamp('linked_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    uniqChannelExternal: uniqueIndex('maestro_links_channel_external_uniq').on(
      t.channel,
      t.externalId,
    ),
    byUser: index('maestro_links_user_idx').on(t.userId),
  }),
);

export type MaestroChannelLink = typeof maestroChannelLinks.$inferSelect;
export type NewMaestroChannelLink = typeof maestroChannelLinks.$inferInsert;
