CREATE TABLE IF NOT EXISTS "whatsapp_message_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "channel_id" bigint NOT NULL,
  "waba_id" varchar(64) NOT NULL,
  "meta_template_id" varchar(64) NOT NULL,
  "name" varchar(512) NOT NULL,
  "language" varchar(32) NOT NULL,
  "category" varchar(32) NOT NULL,
  "status" varchar(32) NOT NULL,
  "rejection_reason" varchar(64),
  "components" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "last_synced_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "whatsapp_message_templates_workspace_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE,
  CONSTRAINT "whatsapp_message_templates_channel_id_fk"
    FOREIGN KEY ("channel_id") REFERENCES "social_media_channels"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_templates_channel_name_lang_uq"
  ON "whatsapp_message_templates" ("channel_id","name","language");
CREATE INDEX IF NOT EXISTS "whatsapp_templates_meta_id_idx"
  ON "whatsapp_message_templates" ("meta_template_id");
CREATE INDEX IF NOT EXISTS "whatsapp_templates_waba_id_idx"
  ON "whatsapp_message_templates" ("waba_id");
CREATE INDEX IF NOT EXISTS "whatsapp_templates_workspace_id_idx"
  ON "whatsapp_message_templates" ("workspace_id");
CREATE INDEX IF NOT EXISTS "whatsapp_templates_channel_id_idx"
  ON "whatsapp_message_templates" ("channel_id");
