-- Maestro reply style, per USER (not per workspace).
--
-- maestro_tone  'simple'       plain everyday English, short answers
--               'professional' the voice Maestro already had  <- default
--               'detailed'     answer plus the reasoning behind it
--
-- Per-user because one workspace holds people of very different technical
-- comfort: a workspace-wide column would let one member's choice change the
-- assistant for everyone else.
--
-- Default 'professional' is the pre-existing behaviour, so every existing row
-- keeps the voice it already had and nobody notices an upgrade.
--
-- Written by hand (not drizzle-kit) to match 0024/0027/0028 and avoid
-- reconciling unrelated journal drift. Idempotent so it is safe to re-run.

DO $$
BEGIN
  CREATE TYPE "public"."maestro_tone" AS ENUM('simple', 'professional', 'detailed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "maestro_tone"
  "public"."maestro_tone" DEFAULT 'professional' NOT NULL;
