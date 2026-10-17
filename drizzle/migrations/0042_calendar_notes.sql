-- 0042 - Planner day notes: one shared note per workspace per calendar day.
--
-- WHY
-- The Planner lets a team pin a short coloured note to a day ("Black Friday
-- sale", "Team offsite"). Notes are shared workspace annotations: one per
-- (workspace, date), 1..500 characters, one of four colours. The date is a
-- plain calendar date, so a note keeps its day when the workspace time zone
-- changes. Deleting a user keeps their notes (author columns become NULL).
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction. Everything is
-- idempotent and non-destructive:
--   * CREATE TABLE IF NOT EXISTS and CREATE UNIQUE INDEX IF NOT EXISTS.
--   * The CHECK constraints are added inside duplicate_object guards, so a
--     re-run is a no-op (same pattern as 0040).
--   * New table only: no existing table or row is read, changed or dropped.
--
-- ROLLBACK
--   DROP TABLE IF EXISTS calendar_notes;
--
-- Never run `db:push` against prod. The boot migrator applies this file.

CREATE TABLE IF NOT EXISTS "calendar_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "date" date NOT NULL,
  "body" text NOT NULL,
  "color" varchar(16) NOT NULL,
  "created_by_id" uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  "updated_by_id" uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "calendar_notes_workspace_date_uq"
  ON "calendar_notes" ("workspace_id", "date");

DO $$
BEGIN
  ALTER TABLE "calendar_notes"
    ADD CONSTRAINT "calendar_notes_body_chk"
    CHECK (char_length("body") BETWEEN 1 AND 500);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "calendar_notes"
    ADD CONSTRAINT "calendar_notes_color_chk"
    CHECK ("color" IN ('amber', 'blue', 'green', 'red'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
