import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { mediaItems } from './media-library.schema';
import { users } from './users.schema';
import { workspace } from './workspace.schema';

/**
 * A saved Insights report: its settings, share link and email schedule. The
 * numbers are never stored; they are computed when the report is opened, sent
 * or exported. Every timestamp is timestamptz. The CHECK constraints live in
 * the SQL only.
 * Migration: drizzle/migrations/0066_insight_reports.sql (hand-written).
 */
export const insightReports = pgTable(
  'insight_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    channelIds: integer('channel_ids').array().notNull(),
    period: text('period').notNull(),
    customFrom: date('custom_from', { mode: 'string' }),
    customTo: date('custom_to', { mode: 'string' }),
    compare: text('compare').notNull(),
    chartMetric: text('chart_metric').notNull(),
    sections: text('sections').array().notNull(),
    note: text('note'),
    logoMediaId: uuid('logo_media_id').references(() => mediaItems.id, {
      onDelete: 'set null',
    }),
    optedOut: text('opted_out')
      .array()
      .notNull()
      .default(sql`'{}'`),
    shareToken: text('share_token').unique(),
    cadence: text('cadence'),
    weekday: smallint('weekday'),
    sendMinute: smallint('send_minute'),
    sendToTeam: boolean('send_to_team').notNull().default(false),
    recipients: text('recipients')
      .array()
      .notNull()
      .default(sql`'{}'`),
    attachPdf: boolean('attach_pdf').notNull().default(true),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    updatedBy: uuid('updated_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('insight_reports_workspace_idx').on(
      t.workspaceId,
      t.createdAt.desc(),
    ),
    index('insight_reports_due_idx')
      .on(t.nextRunAt)
      .where(sql`${t.cadence} IS NOT NULL`),
  ],
);

export type InsightReportRow = typeof insightReports.$inferSelect;
export type NewInsightReportRow = typeof insightReports.$inferInsert;
