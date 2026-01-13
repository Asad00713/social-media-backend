ALTER TABLE "users" ADD COLUMN "is_email_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verification_token" varchar(255);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verification_token_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_reset_token" varchar(255);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_reset_token_expires_at" timestamp;