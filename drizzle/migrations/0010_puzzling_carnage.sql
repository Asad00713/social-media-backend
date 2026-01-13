CREATE TYPE "public"."user_role" AS ENUM('USER', 'SUPER_ADMIN');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" "user_role" DEFAULT 'USER' NOT NULL;