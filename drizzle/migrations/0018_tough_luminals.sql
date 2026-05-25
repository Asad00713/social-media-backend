ALTER TABLE "inbox_items" ADD COLUMN "conversation_id" varchar(255);--> statement-breakpoint
CREATE INDEX "inbox_conversation_idx" ON "inbox_items" USING btree ("channel_id","conversation_id");--> statement-breakpoint
CREATE INDEX "inbox_workspace_conversation_idx" ON "inbox_items" USING btree ("workspace_id","conversation_id");