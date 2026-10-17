import {
  date,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from './users.schema';
import { workspace } from './workspace.schema';

export const NOTE_COLORS = ['amber', 'blue', 'green', 'red'] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

/**
 * A short shared note pinned to one calendar day of a workspace.
 * `date` is a plain calendar date (yyyy-MM-dd): no time zone maths.
 * Migration: drizzle/migrations/0042_calendar_notes.sql (hand-written; the
 * CHECKs on body length and colour live there).
 */
export const calendarNotes = pgTable(
  'calendar_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    date: date('date', { mode: 'string' }).notNull(),
    body: text('body').notNull(),
    color: varchar('color', { length: 16 }).$type<NoteColor>().notNull(),
    createdById: uuid('created_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    updatedById: uuid('updated_by_id').references(() => users.id, {
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
    uniqueIndex('calendar_notes_workspace_date_uq').on(t.workspaceId, t.date),
  ],
);

export type CalendarNoteRow = typeof calendarNotes.$inferSelect;
