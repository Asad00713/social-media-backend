import {
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.schema';
import { workspace } from './workspace.schema';

/**
 * One person's Planner view settings in one workspace. `prefs` is sparse:
 * only keys the user changed are stored; `resolvePrefs` fills the defaults.
 * Migration: drizzle/migrations/0043_planner_preferences.sql (hand-written).
 */
export const plannerPreferences = pgTable(
  'planner_preferences',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    prefs: jsonb('prefs')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.workspaceId] })],
);

export type PlannerPreferencesRow = typeof plannerPreferences.$inferSelect;
