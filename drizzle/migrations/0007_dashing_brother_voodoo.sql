ALTER TABLE "posts" ALTER COLUMN "retry_count" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "job_id" varchar(100);