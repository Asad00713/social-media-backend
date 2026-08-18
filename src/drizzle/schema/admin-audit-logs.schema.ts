import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

export const AUDIT_ACTIONS = [
  'user.suspend',
  'user.reactivate',
  'workspace.suspend',
  'workspace.reactivate',
  'channel.disconnect',
  'member.remove',
  'invitation.cancel',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_TARGET_TYPES = [
  'user',
  'workspace',
  'channel',
  'member',
  'invitation',
] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

/**
 * Append-only record of super-admin actions. Rows are only inserted (never
 * updated) and deleted only by the retention cron. actor_id / target_id are
 * intentionally NOT foreign keys: the log is a historical record that must
 * survive deletion of whatever it references. actor_email and target_label are
 * denormalized snapshots taken at action time so the row stays readable even
 * after the actor or target is deleted.
 */
export const adminAuditLogs = pgTable(
  'admin_audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    action: varchar('action', { length: 40 }).$type<AuditAction>().notNull(),
    actorId: uuid('actor_id').notNull(),
    actorEmail: varchar('actor_email', { length: 255 }),
    targetType: varchar('target_type', { length: 20 })
      .$type<AuditTargetType>()
      .notNull(),
    targetId: varchar('target_id', { length: 64 }).notNull(),
    targetLabel: varchar('target_label', { length: 255 }),
    reason: varchar('reason', { length: 40 }),
    note: text('note'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    createdIdx: index('admin_audit_created_idx').on(table.createdAt),
    actionCreatedIdx: index('admin_audit_action_created_idx').on(
      table.action,
      table.createdAt,
    ),
    actorCreatedIdx: index('admin_audit_actor_created_idx').on(
      table.actorId,
      table.createdAt,
    ),
    targetIdx: index('admin_audit_target_idx').on(
      table.targetType,
      table.targetId,
    ),
  }),
);

export type AdminAuditLog = typeof adminAuditLogs.$inferSelect;
