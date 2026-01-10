CREATE TABLE "addon_pricing" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"plan_code" varchar(20) NOT NULL,
	"addon_type" varchar(30) NOT NULL,
	"price_per_unit_cents" integer NOT NULL,
	"stripe_price_id" varchar(255) NOT NULL,
	"min_quantity" integer DEFAULT 1,
	"max_quantity" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "addon_pricing_plan_code_addon_type_unique" UNIQUE("plan_code","addon_type")
);
--> statement-breakpoint
CREATE TABLE "billing_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"stripe_event_id" varchar(255) NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"subscription_id" integer,
	"payload" jsonb NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"processed_at" timestamp,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "billing_events_stripe_event_id_unique" UNIQUE("stripe_event_id")
);
--> statement-breakpoint
CREATE TABLE "failed_payments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"subscription_id" integer NOT NULL,
	"invoice_id" integer,
	"failure_reason" text,
	"attempt_count" integer DEFAULT 1 NOT NULL,
	"user_notified" boolean DEFAULT false NOT NULL,
	"features_restricted" boolean DEFAULT false NOT NULL,
	"restriction_date" timestamp,
	"resolved" boolean DEFAULT false NOT NULL,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_line_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"invoice_id" integer NOT NULL,
	"stripe_line_item_id" varchar(255),
	"description" text NOT NULL,
	"item_type" varchar(30),
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"period_start" timestamp,
	"period_end" timestamp,
	"is_proration" boolean DEFAULT false NOT NULL,
	"proration_details" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"subscription_id" integer,
	"stripe_invoice_id" varchar(255) NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer NOT NULL,
	"amount_paid_cents" integer DEFAULT 0 NOT NULL,
	"amount_due_cents" integer DEFAULT 0 NOT NULL,
	"currency" varchar(10) DEFAULT 'usd' NOT NULL,
	"status" varchar(20) NOT NULL,
	"period_start" timestamp,
	"period_end" timestamp,
	"paid_at" timestamp,
	"next_payment_attempt" timestamp,
	"invoice_pdf_url" text,
	"hosted_invoice_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_stripe_invoice_id_unique" UNIQUE("stripe_invoice_id")
);
--> statement-breakpoint
CREATE TABLE "payment_methods" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"stripe_customer_id" varchar(255) NOT NULL,
	"stripe_payment_method_id" varchar(255) NOT NULL,
	"type" varchar(20) NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"card_brand" varchar(20),
	"card_last4" varchar(4),
	"card_exp_month" integer,
	"card_exp_year" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payment_methods_stripe_payment_method_id_unique" UNIQUE("stripe_payment_method_id")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" varchar(100) NOT NULL,
	"base_price_cents" integer NOT NULL,
	"stripe_price_id" varchar(255),
	"channels_per_workspace" integer NOT NULL,
	"members_per_workspace" integer NOT NULL,
	"max_workspaces" integer NOT NULL,
	"features" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "plans_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "stripe_customers" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"stripe_customer_id" varchar(255) NOT NULL,
	"email" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_customers_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "stripe_customers_stripe_customer_id_unique" UNIQUE("stripe_customer_id")
);
--> statement-breakpoint
CREATE TABLE "subscription_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"subscription_id" integer NOT NULL,
	"change_type" varchar(50) NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"proration_amount_cents" integer,
	"effective_date" timestamp DEFAULT now() NOT NULL,
	"changed_by_user_id" text,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"subscription_id" integer NOT NULL,
	"stripe_subscription_item_id" varchar(255),
	"item_type" varchar(30) NOT NULL,
	"stripe_price_id" varchar(255) NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_items_stripe_subscription_item_id_unique" UNIQUE("stripe_subscription_item_id"),
	CONSTRAINT "subscription_items_subscription_id_item_type_unique" UNIQUE("subscription_id","item_type")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"stripe_customer_id" varchar(255) NOT NULL,
	"stripe_subscription_id" varchar(255),
	"plan_code" varchar(20) NOT NULL,
	"status" varchar(20) NOT NULL,
	"current_period_start" timestamp,
	"current_period_end" timestamp,
	"trial_end" timestamp,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_workspace_id_unique" UNIQUE("workspace_id"),
	CONSTRAINT "subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id")
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"event_type" varchar(50) NOT NULL,
	"resource_type" varchar(30) NOT NULL,
	"resource_id" text,
	"quantity_before" integer NOT NULL,
	"quantity_after" integer NOT NULL,
	"quantity_delta" integer NOT NULL,
	"triggered_by_user_id" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_usage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"channels_count" integer DEFAULT 0 NOT NULL,
	"channels_limit" integer NOT NULL,
	"extra_channels_purchased" integer DEFAULT 0 NOT NULL,
	"members_count" integer DEFAULT 0 NOT NULL,
	"members_limit" integer NOT NULL,
	"extra_members_purchased" integer DEFAULT 0 NOT NULL,
	"last_calculated_at" timestamp DEFAULT now(),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_usage_workspace_id_unique" UNIQUE("workspace_id")
);
--> statement-breakpoint
ALTER TABLE "addon_pricing" ADD CONSTRAINT "addon_pricing_plan_code_plans_code_fk" FOREIGN KEY ("plan_code") REFERENCES "public"."plans"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "failed_payments" ADD CONSTRAINT "failed_payments_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "failed_payments" ADD CONSTRAINT "failed_payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_customers" ADD CONSTRAINT "stripe_customers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_changes" ADD CONSTRAINT "subscription_changes_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_changes" ADD CONSTRAINT "subscription_changes_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_items" ADD CONSTRAINT "subscription_items_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_code_plans_code_fk" FOREIGN KEY ("plan_code") REFERENCES "public"."plans"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_triggered_by_user_id_users_id_fk" FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_usage" ADD CONSTRAINT "workspace_usage_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;