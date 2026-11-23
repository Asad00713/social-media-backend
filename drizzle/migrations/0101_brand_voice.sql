-- 0101 - Brand voice: the tone, words, emoji and hashtag rules the AI follows.
--
-- WHY
-- Settings > Brand voice lets a workspace say how its posts should sound.
-- The values live in a table of their own, one row per workspace:
--   tone          up to 4 of Warm, Clear, Playful, Bold, Calm, Formal, Witty,
--                 Expert, Friendly.
--   description   one sentence about the brand, at most 240 characters.
--   words_use / words_avoid   up to 20 words each.
--   emoji_level   none | few | lots (default few).
--   hashtags_mode none | few | many | saved_groups (default few).
--   channel_tweaks  {platform: one line}, checked by the API against the
--                 known publishing platforms.
--   version       optimistic-lock counter; a stale save is refused (409).
--   previous      the fields as they were before the last save, for one Undo.
-- It is NOT a set of columns on workspace_brand_profiles: that table is the
-- first-week state machine (source and status are NOT NULL first-week
-- values) and the existence of a row there is what starts a new workspace's
-- first week. Saving a brand voice must not create one.
-- Existing workspaces start with what first-week already learned: tone from
-- workspace_brand_profiles.voice (only the nine known tones, in order, no
-- duplicates, at most 4) and description from sells + audience, cut to 240
-- characters. A brand learned from Threads posts is skipped: Threads API
-- data is never copied anywhere an LLM can read it.
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY. Additive only: one new table, nothing existing is changed or
-- dropped. The backfill only reads workspace_brand_profiles and inserts with
-- ON CONFLICT ("workspace_id") DO NOTHING, so a re-run never overwrites a
-- row someone has already edited. The old backend never reads the table, so
-- applying this before the deploy is safe. Idempotent: CREATE TABLE IF NOT
-- EXISTS (the inline CHECKs go with it).
--
-- LOCKS AND COST
-- `SET LOCAL lock_timeout = '10s'` comes first. The foreign key takes SHARE
-- ROW EXCLUSIVE on workspace until COMMIT (the new table is empty, so no
-- scan). Without the timeout it would queue behind an open transaction on
-- the still-running old instance and every workspace read would queue
-- behind it; with it a blocked deploy fails fast and rolls back. Retry the
-- deploy. The backfill is one pass over workspace_brand_profiles, a table
-- with one row per workspace.
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   DROP TABLE IF EXISTS workspace_brand_voice;
-- Revert the code first: the new code reads this table on every AI call.
-- Dropping it forgets every brand voice a person has saved.
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS "workspace_brand_voice" (
  "workspace_id" uuid PRIMARY KEY REFERENCES "workspace" ("id") ON DELETE CASCADE,
  "tone" text[] NOT NULL DEFAULT '{}',
  "description" text,
  "words_use" text[] NOT NULL DEFAULT '{}',
  "words_avoid" text[] NOT NULL DEFAULT '{}',
  "emoji_level" text NOT NULL DEFAULT 'few',
  "hashtags_mode" text NOT NULL DEFAULT 'few',
  "channel_tweaks" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" integer NOT NULL DEFAULT 1,
  "previous" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_brand_voice_tone_chk"
    CHECK ("tone" <@ ARRAY['Warm','Clear','Playful','Bold','Calm','Formal','Witty','Expert','Friendly']::text[] AND cardinality("tone") <= 4),
  CONSTRAINT "workspace_brand_voice_emoji_chk"
    CHECK ("emoji_level" IN ('none', 'few', 'lots')),
  CONSTRAINT "workspace_brand_voice_hashtags_chk"
    CHECK ("hashtags_mode" IN ('none', 'few', 'many', 'saved_groups')),
  CONSTRAINT "workspace_brand_voice_description_chk"
    CHECK ("description" IS NULL OR char_length("description") <= 240),
  CONSTRAINT "workspace_brand_voice_words_chk"
    CHECK (cardinality("words_use") <= 20 AND cardinality("words_avoid") <= 20),
  CONSTRAINT "workspace_brand_voice_tweaks_chk"
    CHECK (jsonb_typeof("channel_tweaks") = 'object'),
  CONSTRAINT "workspace_brand_voice_version_chk"
    CHECK ("version" >= 1)
);

INSERT INTO "workspace_brand_voice" ("workspace_id", "tone", "description")
SELECT p."workspace_id", t."tone", d."description"
FROM "workspace_brand_profiles" p
CROSS JOIN LATERAL (
  SELECT COALESCE(array_agg(picked.canon ORDER BY picked.pos), '{}'::text[]) AS "tone"
  FROM (SELECT c.canon, min(v.pos) AS pos
          FROM unnest(p."voice") WITH ORDINALITY AS v(word, pos)
          JOIN (VALUES ('Warm'),('Clear'),('Playful'),('Bold'),('Calm'),('Formal'),('Witty'),('Expert'),('Friendly')) AS c(canon)
            ON lower(btrim(v.word)) = lower(c.canon)
         GROUP BY c.canon ORDER BY min(v.pos) LIMIT 4) picked
) t
CROSS JOIN LATERAL (
  SELECT CASE WHEN btrim(COALESCE(p."sells", '')) = '' THEN NULL
    ELSE rtrim(left(regexp_replace(btrim(p."sells")
           || CASE WHEN btrim(COALESCE(p."audience", '')) <> '' THEN ' for ' || btrim(p."audience") ELSE '' END,
         '\s+', ' ', 'g'), 240)) END AS "description"
) d
WHERE NOT (p."source" = 'posts' AND p."source_platform" = 'threads')
  AND (cardinality(t."tone") > 0 OR d."description" IS NOT NULL)
ON CONFLICT ("workspace_id") DO NOTHING;
