import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

export const LOG_LEVELS = ['error', 'warn'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Application error/warning logs. Written fire-and-forget by the custom logger
 * (AppLoggerService) and the global exception filter. Only 'error' and 'warn'
 * are captured — info/debug would be a per-call DB write for no signal.
 *
 * userId/workspaceId are intentionally NOT foreign keys: a log is a historical
 * record and must survive the deletion of whatever it references (and must not
 * block that deletion).
 */
export const errorLogs = pgTable(
  'error_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    level: varchar('level', { length: 10 }).$type<LogLevel>().notNull(),
    message: text('message').notNull(),
    // Nest logger context — the module/service name (e.g. 'SlackService'), or
    // 'HTTP' for rows written by the exception filter.
    context: varchar('context', { length: 255 }),
    stack: text('stack'),
    path: varchar('path', { length: 500 }),
    method: varchar('method', { length: 10 }),
    statusCode: integer('status_code'),
    userId: uuid('user_id'),
    workspaceId: uuid('workspace_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    levelCreatedIdx: index('error_logs_level_created_idx').on(
      table.level,
      table.createdAt,
    ),
    contextCreatedIdx: index('error_logs_context_created_idx').on(
      table.context,
      table.createdAt,
    ),
    createdIdx: index('error_logs_created_idx').on(table.createdAt),
  }),
);

export type ErrorLog = typeof errorLogs.$inferSelect;
