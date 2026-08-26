import {
  bigint,
  index,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { workspace } from './workspace.schema';
import { socialMediaChannels } from './channels.schema';

/** Meta's full status set. Stored verbatim — the UI groups these into tones.
 *  Meta may add values, so consumers must tolerate an unrecognized string. */
export const WHATSAPP_TEMPLATE_STATUS = [
  'APPROVED',
  'PENDING',
  'REJECTED',
  'PAUSED',
  'DISABLED',
  'FLAGGED',
  'ARCHIVED',
  'UNARCHIVED',
  'DELETED',
  'IN_APPEAL',
  'LIMIT_EXCEEDED',
  'LOCKED',
  'REINSTATED',
  'PENDING_DELETION',
] as const;
export type WhatsAppTemplateStatus = (typeof WHATSAPP_TEMPLATE_STATUS)[number];

export const WHATSAPP_TEMPLATE_CATEGORY = [
  'MARKETING',
  'UTILITY',
  'AUTHENTICATION',
] as const;
export type WhatsAppTemplateCategory =
  (typeof WHATSAPP_TEMPLATE_CATEGORY)[number];

export const WHATSAPP_TEMPLATE_REJECTION_REASON = [
  'ABUSIVE_CONTENT',
  'CATEGORY_NOT_AVAILABLE',
  'INCORRECT_CATEGORY',
  'INVALID_FORMAT',
  'NONE',
  'PROMOTIONAL',
  'SCAM',
  'TAG_CONTENT_MISMATCH',
] as const;

/** One HEADER/BODY/FOOTER/BUTTONS block as Meta returns it. Kept loose on
 *  purpose: Phase 1 only renders these, and Meta's component shape varies by
 *  format far more than Phase 1 needs to model. */
export interface WhatsAppTemplateComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';
  format?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION';
  text?: string;
  buttons?: Array<Record<string, any>>;
  example?: Record<string, any>;
}

export const whatsappMessageTemplates = pgTable(
  'whatsapp_message_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),

    /** The channel whose token synced this row. `social_media_channels.id` is
     *  a bigserial, so this is a bigint — NOT a uuid like the other FKs. */
    channelId: bigint('channel_id', { mode: 'number' })
      .notNull()
      .references(() => socialMediaChannels.id, { onDelete: 'cascade' }),

    /** Denormalized from channel.metadata.wabaId so webhook lookups, which
     *  arrive keyed by WABA, do not have to join through channels. */
    wabaId: varchar('waba_id', { length: 64 }).notNull(),

    /** Meta's own id. The upsert key. */
    metaTemplateId: varchar('meta_template_id', { length: 64 }).notNull(),

    name: varchar('name', { length: 512 }).notNull(),
    language: varchar('language', { length: 32 }).notNull(),

    /** Meta's RETURNED category, never the requested one — Meta silently
     *  overrides UTILITY to MARKETING, and category drives pricing. */
    category: varchar('category', { length: 32 })
      .$type<WhatsAppTemplateCategory>()
      .notNull(),

    status: varchar('status', { length: 32 })
      .$type<WhatsAppTemplateStatus>()
      .notNull(),

    rejectionReason: varchar('rejection_reason', { length: 64 }),

    components: jsonb('components')
      .$type<WhatsAppTemplateComponent[]>()
      .notNull()
      .default([]),

    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Meta's identity for a template is (name, language) within a WABA.
    uniqueIndex('whatsapp_templates_channel_name_lang_uq').on(
      table.channelId,
      table.name,
      table.language,
    ),
    index('whatsapp_templates_meta_id_idx').on(table.metaTemplateId),
    index('whatsapp_templates_waba_id_idx').on(table.wabaId),
    index('whatsapp_templates_workspace_id_idx').on(table.workspaceId),
    index('whatsapp_templates_channel_id_idx').on(table.channelId),
  ],
);

export const whatsappMessageTemplatesRelations = relations(
  whatsappMessageTemplates,
  ({ one }) => ({
    workspace: one(workspace, {
      fields: [whatsappMessageTemplates.workspaceId],
      references: [workspace.id],
    }),
    channel: one(socialMediaChannels, {
      fields: [whatsappMessageTemplates.channelId],
      references: [socialMediaChannels.id],
    }),
  }),
);

export type WhatsAppMessageTemplate =
  typeof whatsappMessageTemplates.$inferSelect;
export type NewWhatsAppMessageTemplate =
  typeof whatsappMessageTemplates.$inferInsert;
