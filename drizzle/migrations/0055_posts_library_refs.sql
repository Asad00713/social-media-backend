-- 0055 - Library: posts carry library references; a trigger keeps usage
-- counts as post counts.
--
-- WHY
-- A Library item's "Used in N posts" has to be a real count of posts, not a
-- click counter, and the Library has to find those posts quickly.
--   1. posts.library_refs and posts.media_urls are STORED GENERATED columns:
--      every `libraryItemId` and every media `url` found in media_items and in
--      any platform override (platform_content, at any depth). A post refers
--      to a media item by id (picked from the Library) or by URL (legacy
--      posts, pasted URLs). Both are jsonb arrays; lax `.**` may repeat a
--      value, which containment (`@>`) ignores. The expressions use only
--      immutable functions (jsonb_path_query_array without `_tz`, `||`,
--      COALESCE), and lax mode never raises on an unexpected shape, so no
--      existing row can fail the rewrite.
--   2. GIN (jsonb_path_ops) indexes on both columns serve the `@>` lookups,
--      and one on campaign_slot_content(content->'media') serves the Library's
--      "used in" lookup over campaign slots. No migration creates
--      campaign_slot_content (prod has it by hand), so that index is built
--      only where the table exists; a database without it still boots.
--   3. library_post_text(content, platform_content): the text a link or
--      snippet is searched in. It is `content` plus the UNESCAPED string
--      values of platform_content, minus the strings inside any `mediaItems`
--      (urls, media types, alt text). Searching platform_content::text instead
--      would see JSON escapes (`\n`, `\"`), so a multi-line snippet or a link
--      followed by a newline inside an override would be missed, and a short
--      snippet equal to a JSON key or media token (`image`, `url`) would match
--      every post with media.
--   4. library_url_in_text(txt, url): a saved link counts only where its URL
--      (found first with a cheap strpos, then confirmed by a regex) is
--      followed by end of text, `?`, `#`, `&`, `"` or whitespace (B5),
--      optionally after trailing sentence punctuation (`.,;:!)`), so
--      `https://shop.example/p` matches `.../p?utm_source=ig`, `.../p.` and
--      `(.../p)` but not `.../pricing` or `.../p.html`. The URL is
--      regex-escaped first.
--   5. library_usage_on_post_change(), fired AFTER INSERT / DELETE and AFTER
--      UPDATE of media_items, platform_content or content (only when one of
--      them really changed), recounts usage_count for the media items, saved
--      links and snippets (at least 3 characters) the old or new row refers
--      to, counting only posts of the same workspace (B4). It takes a
--      per-workspace advisory lock first, so concurrent post writes in one
--      workspace recount one after another, and each recount statement takes
--      a fresh snapshot (READ COMMITTED), so it sees every committed post. A
--      post deleted by a workspace cascade is skipped: the workspace and its
--      Library are going too.
--   6. A one-time recount sets every existing usage_count to the same post
--      count. Snippets under 3 characters are set to 0 (B5): a two-letter
--      snippet is contained in nearly every post.
--
-- SAFETY
-- The boot migrator runs this file in ONE transaction; no BEGIN/COMMIT, no
-- CONCURRENTLY. Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT
-- EXISTS (the slot index inside a to_regclass guard), CREATE OR REPLACE
-- FUNCTION, DROP TRIGGER IF EXISTS before each CREATE TRIGGER, and the
-- recount writes only rows whose usage_count differs from the count, so a
-- second run changes nothing.
-- The two generated columns REWRITE `posts` under ACCESS EXCLUSIVE, so reads
-- and writes on posts wait for the rewrite and the two GIN builds. The slot
-- index locks campaign_slot_content against writes while it builds. Nothing
-- is dropped or deleted.
--
-- DEPLOY GATE
--   - Before deploying, the owner runs this read-only query in the Railway
--     prod console: `SELECT count(*), pg_size_pretty(pg_total_relation_size('posts')) FROM posts;`
--   - **Under 100,000 rows AND under 500 MB:** deploy without timing. The
--     rewrite plus the index builds is expected well under 30 s.
--   - **At or over either number:** first time this file on a restored copy
--     of prod. If it holds the lock longer than 30 s, deploy in a low-traffic
--     window.
--   - The link and snippet recount (section 7) also runs under that lock. The
--     owner runs these read-only queries too:
--       `SELECT count(*) FROM saved_links;`
--       `SELECT count(*) FROM text_snippets;`
--       and the exact work it does, the (link + snippet) x post pairs summed
--       per workspace:
--       `SELECT coalesce(sum(p.n * (coalesce(l.n, 0) + coalesce(s.n, 0))), 0) AS pairs
--          FROM (SELECT workspace_id, count(*) AS n FROM posts GROUP BY 1) p
--          LEFT JOIN (SELECT workspace_id, count(*) AS n FROM saved_links GROUP BY 1) l USING (workspace_id)
--          LEFT JOIN (SELECT workspace_id, count(*) AS n FROM text_snippets GROUP BY 1) s USING (workspace_id);`
--   - **posts under 100,000 AND pairs under 2,000,000:** deploy without
--     timing. Measured locally (PG 17, one workspace, posts of ~600
--     characters with an override, each post's text built once):
--       2,000 posts x (500 links + 500 snippets)    =  2,000,000 pairs: 1.6 s
--       5,000 posts x (1,000 links + 1,000 snippets) = 10,000,000 pairs: 30 s
--     So 2,000,000 pairs leaves roughly a 15x margin for a slower prod host
--     inside the 30 s budget above; 10,000,000 already spends all of it.
--     (links + snippets) x posts is an upper bound on pairs, so when that
--     product is under 2,000,000 the pair query is not needed.
--   - **At or over:** time this file on a restored copy of prod, as above.
--
-- LOCKS AND COST
-- `SET LOCAL lock_timeout = '10s'` comes first (I4): without it the ALTER on
-- posts would queue behind any open transaction on the still-running old
-- instance, and every posts read would queue behind the ALTER. With it a
-- blocked deploy fails fast and rolls back; retry the deploy.
-- After deploy, every write to a post's media or text runs the trigger. The
-- media recount uses the GIN indexes. The link and snippet recounts do ONE
-- workspace-wide scan of posts (building library_post_text per post) for
-- EACH link or snippet the written post matches, all under the workspace's
-- advisory lock, so post writes in one workspace serialise behind it.
-- Measured locally: one post write costs ~0.1 s in a workspace of 2,000
-- posts and 1,000 links + snippets, ~1.4 s at 5,000 posts and 2,000. That is
-- accepted pre-launch (workspaces hold hundreds of posts, a post matches a
-- handful of links/snippets). library_url_in_text checks a plain strpos
-- before the regex, so the regex only runs where the URL is present. The
-- later fix is a pg_trgm GIN index on the searched text, so each recount
-- becomes an index lookup.
-- Advisory-lock order: a transaction that writes posts in more than one
-- workspace (a cascaded user delete removes that user's posts in every
-- workspace they wrote in) takes one advisory lock per workspace, in row
-- order. Two such transactions over the same workspaces in a different order
-- can deadlock. It is rare, and Postgres detects it: one transaction aborts
-- with a deadlock error and can be retried. A workspace delete takes no lock
-- at all (its posts are skipped, see WHY 5).
--
-- NEVER edit this file after it has been applied: the migrator's checksum
-- guard refuses to boot. Write a new migration for any later change.
--
-- ROLLBACK
--   DROP TRIGGER IF EXISTS posts_library_usage_ins_del ON posts;
--   DROP TRIGGER IF EXISTS posts_library_usage_upd ON posts;
--   DROP FUNCTION IF EXISTS library_usage_on_post_change();
--   DROP FUNCTION IF EXISTS library_url_in_text(text, text);
--   DROP FUNCTION IF EXISTS library_post_text(text, jsonb);
--   DROP INDEX IF EXISTS campaign_slot_content_media_gin;
--   DROP INDEX IF EXISTS posts_media_urls_gin;
--   DROP INDEX IF EXISTS posts_library_refs_gin;
--   ALTER TABLE posts DROP COLUMN IF EXISTS media_urls,
--     DROP COLUMN IF EXISTS library_refs;
--   NOT reversible: the recounted usage_count values (the old click counts
--   are not kept).
--
-- Never run `db:push` against prod. The boot migrator applies this file.

SET LOCAL lock_timeout = '10s';

-- 1. Generated columns -------------------------------------------------------

ALTER TABLE posts ADD COLUMN IF NOT EXISTS library_refs jsonb GENERATED ALWAYS AS (
  jsonb_path_query_array(COALESCE(media_items, '[]'::jsonb), '$[*].libraryItemId')
  || jsonb_path_query_array(COALESCE(platform_content, '{}'::jsonb), '$.**.libraryItemId')
) STORED;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS media_urls jsonb GENERATED ALWAYS AS (
  jsonb_path_query_array(COALESCE(media_items, '[]'::jsonb), '$[*].url')
  || jsonb_path_query_array(COALESCE(platform_content, '{}'::jsonb), '$.**.mediaItems[*].url')
) STORED;

-- 2. Indexes -----------------------------------------------------------------

CREATE INDEX IF NOT EXISTS posts_library_refs_gin
  ON posts USING gin (library_refs jsonb_path_ops);
CREATE INDEX IF NOT EXISTS posts_media_urls_gin
  ON posts USING gin (media_urls jsonb_path_ops);

-- campaign_slot_content exists on prod by hand only (WHY 2).
DO $$ BEGIN
  IF to_regclass('public.campaign_slot_content') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS campaign_slot_content_media_gin '
         || 'ON public.campaign_slot_content USING gin ((content->''media'') jsonb_path_ops)';
  END IF;
END $$;

-- 3. Searched text (WHY 3) ---------------------------------------------------

CREATE OR REPLACE FUNCTION library_post_text(content text, platform_content jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(content, '') || ' ' || coalesce((
    SELECT string_agg(t.s, ' ')
      FROM (
        SELECT v #>> '{}' AS s
          FROM jsonb_path_query(coalesce(platform_content, '{}'::jsonb),
                                'lax $.** ? (@.type() == "string")') AS v
        EXCEPT
        SELECT v #>> '{}'
          FROM jsonb_path_query(coalesce(platform_content, '{}'::jsonb),
                                'lax $.**.mediaItems.** ? (@.type() == "string")') AS v
      ) t
  ), '')
$$;

-- 4. Link boundary helper (B5, WHY 4) ----------------------------------------

CREATE OR REPLACE FUNCTION library_url_in_text(txt text, url text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT url <> '' AND strpos(txt, url) > 0 AND txt ~ (regexp_replace(url, '([.^$*+?(){}\[\]|\\])', '\\\1', 'g') || '[.,;:!)]*($|[?#&"[:space:]])')
$$;

-- 5. Usage-count trigger function --------------------------------------------

CREATE OR REPLACE FUNCTION library_usage_on_post_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ws   uuid;
  refs jsonb := '[]'::jsonb;
  urls jsonb := '[]'::jsonb;
  txt  text  := '';
BEGIN
  IF TG_OP = 'DELETE' THEN
    ws := OLD.workspace_id;
  ELSE
    ws := NEW.workspace_id;
  END IF;

  -- Workspace cascade: the workspace and its Library are being deleted too.
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM workspace WHERE id = ws) THEN
    RETURN NULL;
  END IF;

  -- Serialise recounts per workspace (lock order: see LOCKS AND COST).
  PERFORM pg_advisory_xact_lock(hashtextextended('library-usage:' || ws::text, 0));

  IF TG_OP <> 'INSERT' THEN
    refs := refs || COALESCE(OLD.library_refs, '[]'::jsonb);
    urls := urls || COALESCE(OLD.media_urls, '[]'::jsonb);
    txt  := txt || ' ' || library_post_text(OLD.content, OLD.platform_content);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    refs := refs || COALESCE(NEW.library_refs, '[]'::jsonb);
    urls := urls || COALESCE(NEW.media_urls, '[]'::jsonb);
    txt  := txt || ' ' || library_post_text(NEW.content, NEW.platform_content);
  END IF;

  UPDATE media_items mi
     SET usage_count = (
       SELECT count(*) FROM posts p
        WHERE p.workspace_id = mi.workspace_id
          AND (p.library_refs @> jsonb_build_array(mi.id::text)
               OR p.media_urls @> jsonb_build_array(mi.file_url)))
   WHERE mi.workspace_id = ws
     AND (mi.id::text IN (SELECT jsonb_array_elements_text(refs))
          OR mi.file_url IN (SELECT jsonb_array_elements_text(urls)));

  -- One workspace-wide posts scan per matched link / snippet (LOCKS AND COST).
  UPDATE saved_links l
     SET usage_count = (
       SELECT count(*) FROM posts p
        WHERE p.workspace_id = l.workspace_id
          AND library_url_in_text(library_post_text(p.content, p.platform_content), l.url))
   WHERE l.workspace_id = ws
     AND library_url_in_text(txt, l.url);

  UPDATE text_snippets s
     SET usage_count = (
       SELECT count(*) FROM posts p
        WHERE p.workspace_id = s.workspace_id
          AND strpos(library_post_text(p.content, p.platform_content), btrim(s.content)) > 0)
   WHERE s.workspace_id = ws
     AND char_length(btrim(s.content)) >= 3
     AND strpos(txt, btrim(s.content)) > 0;

  RETURN NULL;
END;
$$;

-- 6. Triggers (two: a WHEN clause cannot reference OLD on INSERT) -----------

DROP TRIGGER IF EXISTS posts_library_usage_ins_del ON posts;
CREATE TRIGGER posts_library_usage_ins_del
  AFTER INSERT OR DELETE ON posts
  FOR EACH ROW
  EXECUTE FUNCTION library_usage_on_post_change();

DROP TRIGGER IF EXISTS posts_library_usage_upd ON posts;
CREATE TRIGGER posts_library_usage_upd
  AFTER UPDATE OF media_items, platform_content, content ON posts
  FOR EACH ROW
  WHEN (OLD.media_items IS DISTINCT FROM NEW.media_items
        OR OLD.platform_content IS DISTINCT FROM NEW.platform_content
        OR OLD.content IS DISTINCT FROM NEW.content)
  EXECUTE FUNCTION library_usage_on_post_change();

-- 7. One-time recount --------------------------------------------------------

UPDATE media_items mi
   SET usage_count = c.n
  FROM (
    SELECT m.id, (
      SELECT count(*) FROM posts p
       WHERE p.workspace_id = m.workspace_id
         AND (p.library_refs @> jsonb_build_array(m.id::text)
              OR p.media_urls @> jsonb_build_array(m.file_url))) AS n
      FROM media_items m
  ) c
 WHERE mi.id = c.id
   AND mi.usage_count IS DISTINCT FROM c.n;

-- Each post's searched text is built once (MATERIALIZED), only for workspaces
-- that have links, then joined to every link of its workspace.
WITH post_text AS MATERIALIZED (
  SELECT p.workspace_id, library_post_text(p.content, p.platform_content) AS txt
    FROM posts p
   WHERE p.workspace_id IN (SELECT workspace_id FROM saved_links)
), counts AS (
  SELECT sl.id, count(pt.workspace_id) AS n
    FROM saved_links sl
    LEFT JOIN post_text pt
      ON pt.workspace_id = sl.workspace_id
     AND library_url_in_text(pt.txt, sl.url)
   GROUP BY sl.id
)
UPDATE saved_links l
   SET usage_count = c.n
  FROM counts c
 WHERE l.id = c.id
   AND l.usage_count IS DISTINCT FROM c.n;

-- Same for snippets; under 3 characters (or NULL) joins nothing, so 0 (B5).
WITH post_text AS MATERIALIZED (
  SELECT p.workspace_id, library_post_text(p.content, p.platform_content) AS txt
    FROM posts p
   WHERE p.workspace_id IN (SELECT workspace_id FROM text_snippets)
), counts AS (
  SELECT ts.id, count(pt.workspace_id) AS n
    FROM text_snippets ts
    LEFT JOIN post_text pt
      ON pt.workspace_id = ts.workspace_id
     AND char_length(btrim(ts.content)) >= 3
     AND strpos(pt.txt, btrim(ts.content)) > 0
   GROUP BY ts.id
)
UPDATE text_snippets s
   SET usage_count = c.n
  FROM counts c
 WHERE s.id = c.id
   AND s.usage_count IS DISTINCT FROM c.n;
