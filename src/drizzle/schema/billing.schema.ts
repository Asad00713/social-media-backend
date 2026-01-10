import { pgTable, uuid, text, timestamp, varchar, integer, boolean, jsonb, bigserial, unique } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users.schema';
import { workspace } from './workspace.schema';

// 1. Stripe Customers - Links users to Stripe customers
export const stripeCustomers = pgTable('stripe_customers', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: uuid('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  stripeCustomerId: varchar('stripe_customer_id', { length: 255 }).notNull().unique(),
  email: varchar('email', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// 2. Plans - Defines available subscription plans
export const plans = pgTable('plans', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  code: varchar('code', { length: 20 }).notNull().unique(),
  name: varchar('name', { length: 100 }).notNull(),
  basePriceCents: integer('base_price_cents').notNull(),
  stripePriceId: varchar('stripe_price_id', { length: 255 }),
  channelsPerWorkspace: integer('channels_per_workspace').notNull(),
  membersPerWorkspace: integer('members_per_workspace').notNull(),
  maxWorkspaces: integer('max_workspaces').notNull(),
  features: jsonb('features'),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 3. Add-on Pricing - Defines pricing for add-ons per plan
export const addonPricing = pgTable('addon_pricing', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  planCode: varchar('plan_code', { length: 20 }).notNull().references(() => plans.code, { onDelete: 'cascade' }),
  addonType: varchar('addon_type', { length: 30 }).notNull(), // EXTRA_CHANNEL, EXTRA_MEMBER, EXTRA_WORKSPACE
  pricePerUnitCents: integer('price_per_unit_cents').notNull(),
  stripePriceId: varchar('stripe_price_id', { length: 255 }).notNull(),
  minQuantity: integer('min_quantity').default(1),
  maxQuantity: integer('max_quantity'), // NULL = unlimited
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => {
  return {
    uniquePlanAddon: unique().on(table.planCode, table.addonType),
  };
});

// 4. Subscriptions - Per-workspace subscriptions
export const subscriptions = pgTable('subscriptions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  workspaceId: uuid('workspace_id').notNull().unique().references(() => workspace.id, { onDelete: 'cascade' }),
  stripeCustomerId: varchar('stripe_customer_id', { length: 255 }).notNull(),
  stripeSubscriptionId: varchar('stripe_subscription_id', { length: 255 }).unique(),
  planCode: varchar('plan_code', { length: 20 }).notNull().references(() => plans.code),
  status: varchar('status', { length: 20 }).notNull(), // active, past_due, canceled, trialing
  currentPeriodStart: timestamp('current_period_start'),
  currentPeriodEnd: timestamp('current_period_end'),
  trialEnd: timestamp('trial_end'),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').default(false).notNull(),
  canceledAt: timestamp('canceled_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 5. Subscription Items - Tracks base plan + all add-ons
export const subscriptionItems = pgTable('subscription_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  subscriptionId: integer('subscription_id').notNull().references(() => subscriptions.id, { onDelete: 'cascade' }),
  stripeSubscriptionItemId: varchar('stripe_subscription_item_id', { length: 255 }).unique(),
  itemType: varchar('item_type', { length: 30 }).notNull(), // BASE_PLAN, EXTRA_CHANNEL, EXTRA_MEMBER, EXTRA_WORKSPACE
  stripePriceId: varchar('stripe_price_id', { length: 255 }).notNull(),
  quantity: integer('quantity').default(1).notNull(),
  unitPriceCents: integer('unit_price_cents').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => {
  return {
    uniqueSubscriptionItem: unique().on(table.subscriptionId, table.itemType),
  };
});

// 6. Workspace Usage - Real-time usage tracking for enforcement
export const workspaceUsage = pgTable('workspace_usage', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  workspaceId: uuid('workspace_id').notNull().unique().references(() => workspace.id, { onDelete: 'cascade' }),
  channelsCount: integer('channels_count').default(0).notNull(),
  channelsLimit: integer('channels_limit').notNull(),
  extraChannelsPurchased: integer('extra_channels_purchased').default(0).notNull(),
  membersCount: integer('members_count').default(0).notNull(),
  membersLimit: integer('members_limit').notNull(),
  extraMembersPurchased: integer('extra_members_purchased').default(0).notNull(),
  lastCalculatedAt: timestamp('last_calculated_at').defaultNow(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 7. Usage Events - Audit trail of all usage changes
export const usageEvents = pgTable('usage_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspace.id, { onDelete: 'cascade' }),
  eventType: varchar('event_type', { length: 50 }).notNull(), // CHANNEL_ADDED, CHANNEL_REMOVED, MEMBER_ADDED, etc.
  resourceType: varchar('resource_type', { length: 30 }).notNull(), // CHANNEL, MEMBER
  resourceId: uuid('resource_id'),
  quantityBefore: integer('quantity_before').notNull(),
  quantityAfter: integer('quantity_after').notNull(),
  quantityDelta: integer('quantity_delta').notNull(),
  triggeredByUserId: uuid('triggered_by_user_id').references(() => users.id),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// 8. Invoices - Mirror of Stripe invoices
export const invoices = pgTable('invoices', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  subscriptionId: integer('subscription_id').references(() => subscriptions.id, { onDelete: 'set null' }),
  stripeInvoiceId: varchar('stripe_invoice_id', { length: 255 }).notNull().unique(),
  subtotalCents: integer('subtotal_cents').notNull(),
  taxCents: integer('tax_cents').default(0).notNull(),
  totalCents: integer('total_cents').notNull(),
  amountPaidCents: integer('amount_paid_cents').default(0).notNull(),
  amountDueCents: integer('amount_due_cents').default(0).notNull(),
  currency: varchar('currency', { length: 10 }).default('usd').notNull(),
  status: varchar('status', { length: 20 }).notNull(), // draft, open, paid, void, uncollectible
  periodStart: timestamp('period_start'),
  periodEnd: timestamp('period_end'),
  paidAt: timestamp('paid_at'),
  nextPaymentAttempt: timestamp('next_payment_attempt'),
  invoicePdfUrl: text('invoice_pdf_url'),
  hostedInvoiceUrl: text('hosted_invoice_url'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 9. Invoice Line Items - Breakdown of what user is paying for
export const invoiceLineItems = pgTable('invoice_line_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  invoiceId: integer('invoice_id').notNull().references(() => invoices.id, { onDelete: 'cascade' }),
  stripeLineItemId: varchar('stripe_line_item_id', { length: 255 }),
  description: text('description').notNull(),
  itemType: varchar('item_type', { length: 30 }),
  quantity: integer('quantity').default(1).notNull(),
  unitPriceCents: integer('unit_price_cents').notNull(),
  totalCents: integer('total_cents').notNull(),
  periodStart: timestamp('period_start'),
  periodEnd: timestamp('period_end'),
  isProration: boolean('is_proration').default(false).notNull(),
  prorationDetails: jsonb('proration_details'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// 10. Billing Events - Stripe webhook event log
export const billingEvents = pgTable('billing_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  stripeEventId: varchar('stripe_event_id', { length: 255 }).notNull().unique(),
  eventType: varchar('event_type', { length: 100 }).notNull(),
  subscriptionId: integer('subscription_id').references(() => subscriptions.id),
  payload: jsonb('payload').notNull(),
  processed: boolean('processed').default(false).notNull(),
  processedAt: timestamp('processed_at'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// 11. Subscription Changes - Log of all subscription modifications
export const subscriptionChanges = pgTable('subscription_changes', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  subscriptionId: integer('subscription_id').notNull().references(() => subscriptions.id, { onDelete: 'cascade' }),
  changeType: varchar('change_type', { length: 50 }).notNull(), // PLAN_UPGRADED, ADDON_ADDED, etc.
  oldValue: jsonb('old_value'),
  newValue: jsonb('new_value'),
  prorationAmountCents: integer('proration_amount_cents'),
  effectiveDate: timestamp('effective_date').defaultNow().notNull(),
  changedByUserId: uuid('changed_by_user_id').references(() => users.id),
  reason: text('reason'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// 12. Payment Methods - User payment methods
export const paymentMethods = pgTable('payment_methods', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  stripeCustomerId: varchar('stripe_customer_id', { length: 255 }).notNull(),
  stripePaymentMethodId: varchar('stripe_payment_method_id', { length: 255 }).notNull().unique(),
  type: varchar('type', { length: 20 }).notNull(), // card, bank_account
  isDefault: boolean('is_default').default(false).notNull(),
  cardBrand: varchar('card_brand', { length: 20 }),
  cardLast4: varchar('card_last4', { length: 4 }),
  cardExpMonth: integer('card_exp_month'),
  cardExpYear: integer('card_exp_year'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 13. Failed Payments - Track payment failures and restrictions
export const failedPayments = pgTable('failed_payments', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  subscriptionId: integer('subscription_id').notNull().references(() => subscriptions.id, { onDelete: 'cascade' }),
  invoiceId: integer('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
  failureReason: text('failure_reason'),
  attemptCount: integer('attempt_count').default(1).notNull(),
  userNotified: boolean('user_notified').default(false).notNull(),
  featuresRestricted: boolean('features_restricted').default(false).notNull(),
  restrictionDate: timestamp('restriction_date'),
  resolved: boolean('resolved').default(false).notNull(),
  resolvedAt: timestamp('resolved_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Relations
export const stripeCustomersRelations = relations(stripeCustomers, ({ one }) => ({
  user: one(users, {
    fields: [stripeCustomers.userId],
    references: [users.id],
  }),
}));

export const subscriptionsRelations = relations(subscriptions, ({ one, many }) => ({
  workspace: one(workspace, {
    fields: [subscriptions.workspaceId],
    references: [workspace.id],
  }),
  plan: one(plans, {
    fields: [subscriptions.planCode],
    references: [plans.code],
  }),
  subscriptionItems: many(subscriptionItems),
  invoices: many(invoices),
  subscriptionChanges: many(subscriptionChanges),
  failedPayments: many(failedPayments),
}));

export const subscriptionItemsRelations = relations(subscriptionItems, ({ one }) => ({
  subscription: one(subscriptions, {
    fields: [subscriptionItems.subscriptionId],
    references: [subscriptions.id],
  }),
}));

export const workspaceUsageRelations = relations(workspaceUsage, ({ one }) => ({
  workspace: one(workspace, {
    fields: [workspaceUsage.workspaceId],
    references: [workspace.id],
  }),
}));

export const usageEventsRelations = relations(usageEvents, ({ one }) => ({
  workspace: one(workspace, {
    fields: [usageEvents.workspaceId],
    references: [workspace.id],
  }),
  triggeredByUser: one(users, {
    fields: [usageEvents.triggeredByUserId],
    references: [users.id],
  }),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  subscription: one(subscriptions, {
    fields: [invoices.subscriptionId],
    references: [subscriptions.id],
  }),
  lineItems: many(invoiceLineItems),
}));

export const invoiceLineItemsRelations = relations(invoiceLineItems, ({ one }) => ({
  invoice: one(invoices, {
    fields: [invoiceLineItems.invoiceId],
    references: [invoices.id],
  }),
}));

export const plansRelations = relations(plans, ({ many }) => ({
  subscriptions: many(subscriptions),
  addonPricing: many(addonPricing),
}));

export const addonPricingRelations = relations(addonPricing, ({ one }) => ({
  plan: one(plans, {
    fields: [addonPricing.planCode],
    references: [plans.code],
  }),
}));

export const billingEventsRelations = relations(billingEvents, ({ one }) => ({
  subscription: one(subscriptions, {
    fields: [billingEvents.subscriptionId],
    references: [subscriptions.id],
  }),
}));

export const subscriptionChangesRelations = relations(subscriptionChanges, ({ one }) => ({
  subscription: one(subscriptions, {
    fields: [subscriptionChanges.subscriptionId],
    references: [subscriptions.id],
  }),
  changedByUser: one(users, {
    fields: [subscriptionChanges.changedByUserId],
    references: [users.id],
  }),
}));

export const failedPaymentsRelations = relations(failedPayments, ({ one }) => ({
  subscription: one(subscriptions, {
    fields: [failedPayments.subscriptionId],
    references: [subscriptions.id],
  }),
  invoice: one(invoices, {
    fields: [failedPayments.invoiceId],
    references: [invoices.id],
  }),
}));

// Type exports
export type StripeCustomer = typeof stripeCustomers.$inferSelect;
export type NewStripeCustomer = typeof stripeCustomers.$inferInsert;

export type Plan = typeof plans.$inferSelect;
export type NewPlan = typeof plans.$inferInsert;

export type AddonPricing = typeof addonPricing.$inferSelect;
export type NewAddonPricing = typeof addonPricing.$inferInsert;

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;

export type SubscriptionItem = typeof subscriptionItems.$inferSelect;
export type NewSubscriptionItem = typeof subscriptionItems.$inferInsert;

export type WorkspaceUsage = typeof workspaceUsage.$inferSelect;
export type NewWorkspaceUsage = typeof workspaceUsage.$inferInsert;

export type UsageEvent = typeof usageEvents.$inferSelect;
export type NewUsageEvent = typeof usageEvents.$inferInsert;

export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;

export type InvoiceLineItem = typeof invoiceLineItems.$inferSelect;
export type NewInvoiceLineItem = typeof invoiceLineItems.$inferInsert;

export type BillingEvent = typeof billingEvents.$inferSelect;
export type NewBillingEvent = typeof billingEvents.$inferInsert;

export type SubscriptionChange = typeof subscriptionChanges.$inferSelect;
export type NewSubscriptionChange = typeof subscriptionChanges.$inferInsert;

export type PaymentMethod = typeof paymentMethods.$inferSelect;
export type NewPaymentMethod = typeof paymentMethods.$inferInsert;

export type FailedPayment = typeof failedPayments.$inferSelect;
export type NewFailedPayment = typeof failedPayments.$inferInsert;
