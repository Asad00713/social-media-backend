import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.schema';

/** The three states a publishing platform can be in. */
export const PLATFORM_STATES = ['operational', 'delayed', 'outage'] as const;
export type PlatformState = (typeof PLATFORM_STATES)[number];

/** What an incident can force a platform into. */
export const INCIDENT_SEVERITIES = ['delayed', 'outage'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

/** Why the shown state is what it is. */
export const PLATFORM_STATUS_REASONS = [
  'publish_failures',
  'publish_lag',
  'sync_failures',
  'incident',
] as const;
export type PlatformStatusReason = (typeof PLATFORM_STATUS_REASONS)[number];
/** A reason the measurement alone can give. */
export type MeasuredReason = Exclude<PlatformStatusReason, 'incident'>;

/**
 * The numbers one measurement was based on, kept on the row for support
 * ("why is Instagram delayed?"). Never shown to customers.
 */
export interface PlatformSignalsSummary {
  publishSample: number;
  publishFailures: number;
  publishFailureWorkspaces: number;
  lagSample: number;
  medianLagMs: number | null;
  lagWorkspaces: number;
  syncSample: number;
  syncFailures: number;
  syncFailureWorkspaces: number;
}

/**
 * Incidents a super admin posts by hand. `platform` NULL = every platform.
 * While unresolved the severity overrides the measured state.
 * Migration: drizzle/migrations/0083_platform_status.sql (hand-written; the
 * CHECK constraints live there).
 */
export const platformIncidents = pgTable(
  'platform_incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    platform: varchar('platform', { length: 32 }),
    severity: varchar('severity', { length: 16 })
      .$type<IncidentSeverity>()
      .notNull(),
    title: varchar('title', { length: 120 }).notNull(),
    body: text('body'),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
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
    index('platform_incidents_active_idx')
      .on(t.startedAt.desc())
      .where(sql`${t.resolvedAt} IS NULL`),
    index('platform_incidents_resolved_idx')
      .on(t.resolvedAt.desc())
      .where(sql`${t.resolvedAt} IS NOT NULL`),
  ],
);

/** One row per platform: the state shown now and the state measured. */
export const platformStatus = pgTable('platform_status', {
  platform: varchar('platform', { length: 32 }).primaryKey(),
  status: varchar('status', { length: 16 }).$type<PlatformState>().notNull(),
  measuredStatus: varchar('measured_status', { length: 16 })
    .$type<PlatformState>()
    .notNull(),
  measuredReason: varchar('measured_reason', {
    length: 32,
  }).$type<MeasuredReason>(),
  reason: varchar('reason', { length: 32 }).$type<PlatformStatusReason>(),
  incidentId: uuid('incident_id').references(() => platformIncidents.id, {
    onDelete: 'set null',
  }),
  signals: jsonb('signals')
    .$type<Partial<PlatformSignalsSummary>>()
    .notNull()
    .default({}),
  since: timestamp('since', { withTimezone: true }).notNull().defaultNow(),
  measuredAt: timestamp('measured_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Append-only history of every change of the shown state. */
export const platformStatusChanges = pgTable(
  'platform_status_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    platform: varchar('platform', { length: 32 }).notNull(),
    fromStatus: varchar('from_status', { length: 16 })
      .$type<PlatformState>()
      .notNull(),
    toStatus: varchar('to_status', { length: 16 })
      .$type<PlatformState>()
      .notNull(),
    reason: varchar('reason', { length: 32 }).$type<PlatformStatusReason>(),
    incidentId: uuid('incident_id').references(() => platformIncidents.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('platform_status_changes_created_idx').on(t.createdAt.desc())],
);

export type PlatformIncidentRow = typeof platformIncidents.$inferSelect;
export type PlatformStatusRow = typeof platformStatus.$inferSelect;
export type PlatformStatusChangeRow = typeof platformStatusChanges.$inferSelect;
