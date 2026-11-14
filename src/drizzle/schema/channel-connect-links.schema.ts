import {
  char,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from './users.schema';
import { workspace } from './workspace.schema';

/**
 * A "connect link": a public URL (/c/<token>) a client opens to connect their
 * own social accounts into a workspace, with no Schedura account. Status
 * (open / expired / revoked) is derived from expires_at and revoked_at, never
 * stored. Rows are revoked, not deleted.
 * Migration: drizzle/migrations/0067_channel_connect_links.sql (hand-written;
 * the `networks` cardinality CHECK and the unique constraint on token_hash
 * live there).
 */
export const channelConnectLinks = pgTable(
  'channel_connect_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // NULL for a link that was only copied, never emailed.
    email: varchar('email', { length: 320 }),
    // Platform ids the link offers (1-8, enforced by a CHECK).
    networks: text('networks').array().notNull(),
    // SHA-256 of the raw token (hex): the only column a lookup reads.
    tokenHash: char('token_hash', { length: 64 }).notNull(),
    // The raw token, encrypted, so copy / resend reuse the same URL.
    tokenEncrypted: text('token_encrypted').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('channel_connect_links_workspace_created_idx').on(
      t.workspaceId,
      t.createdAt.desc(),
    ),
  ],
);

export type ChannelConnectLink = typeof channelConnectLinks.$inferSelect;
export type NewChannelConnectLink = typeof channelConnectLinks.$inferInsert;
