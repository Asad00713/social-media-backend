-- error_logs was added to src/drizzle/schema/error-logs.schema.ts but never got
-- a migration, so it does not exist on production. Every error the app logs
-- fails a second time trying to persist itself, doubling the noise in the logs.
--
-- userId/workspaceId are deliberately NOT foreign keys: a log is a historical
-- record that must survive deletion of whatever it references.

CREATE TABLE IF NOT EXISTS error_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  level varchar(10) NOT NULL,
  message text NOT NULL,
  context varchar(255),
  stack text,
  path varchar(500),
  method varchar(10),
  status_code integer,
  user_id uuid,
  workspace_id uuid,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS error_logs_level_created_idx ON error_logs (level, created_at);
CREATE INDEX IF NOT EXISTS error_logs_context_created_idx ON error_logs (context, created_at);
CREATE INDEX IF NOT EXISTS error_logs_created_idx ON error_logs (created_at);
