import {
  check,
  index,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.schema';
import { workspace } from './workspace.schema';

export const HIDE_REASONS = ['not_useful', 'later'] as const;
export type HideReason = (typeof HIDE_REASONS)[number];

/**
 * A next step one person hid on the Insights page, in one workspace. Hidden
 * while `hiddenUntil` is in the future. Both timestamps are timestamptz.
 * Migration: drizzle/migrations/0060_insight_hidden_steps.sql (hand-written).
 */
export const insightHiddenSteps = pgTable(
  'insight_hidden_steps',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    /** `format_gap`, `quiet_channel:{id}` or `repost_hit:{postId}:{id}`. */
    stepId: varchar('step_id', { length: 120 }).notNull(),
    hiddenUntil: timestamp('hidden_until', { withTimezone: true }).notNull(),
    reason: varchar('reason', { length: 20 }).$type<HideReason>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.workspaceId, t.stepId] }),
    index('insight_hidden_steps_workspace_id_idx').on(t.workspaceId),
    check(
      'insight_hidden_steps_reason_chk',
      sql`${t.reason} IN ('not_useful', 'later')`,
    ),
  ],
);

export type InsightHiddenStepRow = typeof insightHiddenSteps.$inferSelect;
