-- 0037 — a profile picture, and a fixed colour behind the initials.
--
-- WHY
-- Maestro's conversation list is about to show WHO held each conversation,
-- which an owner or admin sees across the whole workspace. A list of names
-- alone is read line by line; a list of faces is scanned. Nothing else in the
-- product has ever needed a picture of a person, so there is no column for
-- one — the avatar component has been rendering initials on a flat grey.
--
-- `avatar_url` is stored as a URL, not bytes: the file goes to R2 through the
-- same presigned upload the Maestro attachments use, and this column holds
-- where it landed. The database never carries the image, which keeps the row
-- small and makes replacing a picture a write of one short string.
--
-- `avatar_color` is the colour behind the initials when there is no picture,
-- chosen once at sign-up and then fixed. Stored rather than derived from the
-- id at render time, because a derived colour has to be computed identically
-- everywhere it appears — and the day the palette or the hash changes, every
-- user's colour changes with it. An avatar is how colleagues recognise
-- someone in a list; it should be as stable as their name.
--
-- It holds a palette KEY ('amber', 'violet'), never a hex, so light and dark
-- themes can render the same identity differently. See src/users/avatar-colors.ts.
--
-- SAFETY
-- Additive only: two nullable columns, no defaults, no constraints. A nullable
-- ADD COLUMN with no DEFAULT is a catalog-only change in PG 11+, so neither
-- rewrites the table; each takes a brief ACCESS EXCLUSIVE lock and returns.
--
-- The backfill below is the one statement that writes rows. It is a single
-- UPDATE over the users table, which is small (one row per human, not per
-- event), and it is idempotent — re-running it touches nothing, because it
-- only matches rows whose colour is still NULL.
--
-- ROLLBACK
--   ALTER TABLE users DROP COLUMN IF EXISTS avatar_color;
--   ALTER TABLE users DROP COLUMN IF EXISTS avatar_url;
--
-- Uploaded files are NOT removed by that rollback. They are orphaned in R2
-- and cost storage until cleaned up separately; the column can be re-added
-- but the URLs are gone, so re-uploading is the only recovery.
--
-- PROD RUNBOOK
--   1. Apply the two ALTERs, then the UPDATE. Order matters.
--   2. avatar_url is TEXT, not varchar(n): R2 public URLs carry a bucket host,
--      a key and sometimes a query, and a length cap that seemed generous
--      would fail silently at the worst moment — on someone's first upload.
--   3. The backfill's colour list must stay in step with AVATAR_COLORS in
--      src/users/avatar-colors.ts. A key here that the frontend does not know
--      renders as the fallback colour, not as a broken avatar, so drift is
--      survivable — but it makes one user's avatar quietly change.
--   4. Never run `db:push` against prod. See 0030 for what that cost once.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "avatar_url" text;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "avatar_color" varchar(20);

-- Existing accounts get a colour now rather than on next login: an admin
-- opening the conversation list should not see half the team in one default
-- colour while the rest are spread across the palette.
--
-- random() per row, not one colour for everyone. The ordering by id is
-- irrelevant to the result and only makes the plan deterministic.
UPDATE "users"
SET "avatar_color" = (
  ARRAY[
    'amber', 'blue', 'emerald', 'fuchsia', 'indigo', 'lime',
    'orange', 'pink', 'rose', 'sky', 'teal', 'violet'
  ]
)[floor(random() * 12 + 1)]
WHERE "avatar_color" IS NULL;
