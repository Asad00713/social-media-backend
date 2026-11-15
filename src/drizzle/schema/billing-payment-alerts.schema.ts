import {
  bigserial,
  index,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from './users.schema';

/**
 * One row per payment alert the billing owner was sent (migration 0084).
 *
 * `alert_key` is unique: a webhook CLAIMS it with
 * `INSERT … ON CONFLICT DO NOTHING RETURNING` and only the winner alerts, so
 * a redelivered or concurrent webhook can never alert twice. Kept apart from
 * `notifications`, whose rows the user can delete.
 */
export const billingPaymentAlerts = pgTable(
  'billing_payment_alerts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    alertKey: varchar('alert_key', { length: 255 }).notNull().unique(),
    /** `failed` | `recovered` (CHECK in the migration). */
    kind: varchar('kind', { length: 16 })
      .$type<BillingPaymentAlertKind>()
      .notNull(),
    provider: varchar('provider', { length: 20 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('billing_payment_alerts_user_created_idx').on(
      t.userId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
  ],
);

export type BillingPaymentAlertKind = 'failed' | 'recovered';
export type BillingPaymentAlert = typeof billingPaymentAlerts.$inferSelect;
