import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import type { UsageEntry } from '../dto/contract';

/**
 * The one "is this media item used" test (D4, B1). `itemReferencedSql`
 * (Never used, stats, purge) and `MediaUsageService.getUsage` (`/usage`) are
 * both built from the three per-source builders below, so they cannot drift.
 *
 * An item is used by:
 *   - a post of its workspace holding its id (`libraryItemId`) or its exact
 *     `file_url` anywhere in media_items or platform_content (the 0055
 *     generated columns, GIN-indexed);
 *   - a campaign slot of its workspace not yet turned into a post, whose
 *     `content.media[]` holds `{id}` or `{url}` (a materialised slot is
 *     already counted through its post);
 *   - an evergreen pool entry of its workspace whose `content.media[]` or any
 *     `variations[*].media[]` holds `{id}` or `{url}`.
 *
 * The item's fields may be columns of an outer query (correlated) or bound
 * values. Every builder returns a parenthesised predicate, so ANDing it into
 * a larger condition cannot split its OR (drizzle's `and()` does not wrap
 * its operands).
 */
export interface UsageItemRef {
  id: AnyColumn | SQL;
  fileUrl: AnyColumn | SQL;
  workspaceId: AnyColumn | SQL;
}

// Bound values reach jsonb_build_array/_object as untyped parameters, which
// Postgres cannot resolve for a VARIADIC "any" function; the casts fix that
// and are no-ops on columns.
const idText = (item: Pick<UsageItemRef, 'id'>) => sql`(${item.id})::text`;
const urlText = (item: Pick<UsageItemRef, 'fileUrl'>) =>
  sql`(${item.fileUrl})::text`;
const wsUuid = (item: Pick<UsageItemRef, 'workspaceId'>) =>
  sql`(${item.workspaceId})::uuid`;

/** `p` is the alias of a `posts` row. */
export function postRefSql(p: SQL, item: UsageItemRef): SQL {
  return sql`(${p}.workspace_id = ${wsUuid(item)} AND (${p}.library_refs @> jsonb_build_array(${idText(item)}) OR ${p}.media_urls @> jsonb_build_array(${urlText(item)})))`;
}

/** `s` is a `campaign_slot_content` row, `c` its `campaigns` row. */
export function slotRefSql(s: SQL, c: SQL, item: UsageItemRef): SQL {
  return sql`(${c}.workspace_id = ${wsUuid(item)} AND ${s}.post_id IS NULL AND (${s}.content->'media' @> jsonb_build_array(jsonb_build_object('id', ${idText(item)})) OR ${s}.content->'media' @> jsonb_build_array(jsonb_build_object('url', ${urlText(item)}))))`;
}

/** `e` is a `campaign_evergreen_posts` row, `c` its `campaigns` row. */
export function evergreenRefSql(e: SQL, c: SQL, item: UsageItemRef): SQL {
  return sql`(${c}.workspace_id = ${wsUuid(item)} AND jsonb_path_exists(jsonb_build_object('media', ${e}.content->'media', 'variations', ${e}.variations), 'lax $.**.media[*] ? (@.id == $id || @.url == $url)', jsonb_build_object('id', ${idText(item)}, 'url', ${urlText(item)})))`;
}

/** True when any post, unmaterialised slot or evergreen entry uses the item. */
export function itemReferencedSql(item: UsageItemRef): SQL {
  const p = sql.raw('p');
  const s = sql.raw('s');
  const c = sql.raw('c');
  const e = sql.raw('e');
  return sql`(EXISTS (SELECT 1 FROM posts p WHERE ${postRefSql(p, item)}) OR EXISTS (SELECT 1 FROM campaign_slot_content s JOIN campaigns c ON c.id = s.campaign_id WHERE ${slotRefSql(s, c, item)}) OR EXISTS (SELECT 1 FROM campaign_evergreen_posts e JOIN campaigns c ON c.id = e.campaign_id WHERE ${evergreenRefSql(e, c, item)}))`;
}

// ---------------------------------------------------------------------------
// usage_count recounts (I4)
//
// The posts trigger from 0055 (`library_usage_on_post_change`) recounts a
// Library row when a POST changes. A Library write that changes what the row
// matches (a new link or snippet, a link's URL, a snippet's text, a media row
// registered for a URL posts already use) recounts that one row with the
// trigger's own test, below. The trigger's logic lives in SQL only: links
// call its `library_url_in_text` / `library_post_text` functions, snippets
// repeat its `strpos` test and 3-character guard verbatim, and media reuse
// `postRefSql`, which is the trigger's media test.
// ---------------------------------------------------------------------------

/** Posts of the item's workspace that use it: the trigger's media count. */
export function itemPostCountSql(item: UsageItemRef): SQL {
  const p = sql.raw('p');
  return sql`(SELECT count(*)::int FROM posts p WHERE ${postRefSql(p, item)})`;
}

/** Posts of the link's workspace whose text holds its URL (0055, B5). */
export function linkPostCountSql(link: {
  url: AnyColumn | SQL;
  workspaceId: AnyColumn | SQL;
}): SQL {
  return sql`(SELECT count(*)::int FROM posts p WHERE p.workspace_id = ${wsUuid(link)} AND library_url_in_text(library_post_text(p.content, p.platform_content), (${link.url})::text))`;
}

/**
 * Posts of the snippet's workspace whose text holds its trimmed content; 0
 * under 3 characters (0055, B5).
 */
export function snippetPostCountSql(snippet: {
  content: AnyColumn | SQL;
  workspaceId: AnyColumn | SQL;
}): SQL {
  const text = sql`btrim((${snippet.content})::text)`;
  return sql`(SELECT count(*)::int FROM posts p WHERE p.workspace_id = ${wsUuid(snippet)} AND char_length(${text}) >= 3 AND strpos(library_post_text(p.content, p.platform_content), ${text}) > 0)`;
}

/**
 * Runs `fn` in a transaction holding the trigger's per-workspace advisory
 * lock. Call it after the Library row is committed: once the lock is held,
 * every post write that ran before the row existed has committed, so the
 * recount's fresh snapshot sees it; every later post write sees the row and
 * recounts it itself.
 */
export function withUsageLock<T>(
  db: DbType,
  workspaceId: string,
  fn: (tx: DbType) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('library-usage:' || (${workspaceId}::uuid)::text, 0))`,
    );
    return fn(tx as unknown as DbType);
  });
}

/**
 * `t` is a `media_templates` row of the item's workspace (binned or not: a
 * restored template must still find its file) that shows the file URL in
 * `content.media[]` or as its `thumbnail_url`.
 */
export function templateRefSql(
  t: SQL,
  item: Pick<UsageItemRef, 'fileUrl' | 'workspaceId'>,
): SQL {
  return sql`(${t}.workspace_id = ${wsUuid(item)} AND (${t}.thumbnail_url = ${urlText(item)} OR ${t}.content->'media' @> jsonb_build_array(jsonb_build_object('url', ${urlText(item)}))))`;
}

/**
 * The byte-keep test: purge and the discard guard keep a file's bytes while
 * this is true. It is `itemReferencedSql` plus templates (I1).
 *
 * The template arm sits here, outside `itemReferencedSql`, on purpose: that
 * builder also feeds `/usage`, `neverUsed`, stats and the usage count, and a
 * template protects the bytes without making the item "used".
 */
export function itemBytesKeptSql(item: UsageItemRef): SQL {
  const t = sql.raw('t');
  return sql`(${itemReferencedSql(item)} OR EXISTS (SELECT 1 FROM media_templates t WHERE ${templateRefSql(t, item)}))`;
}

/**
 * Set-based twin of `itemReferencedSql` for the stats call: one pass over the
 * workspace's posts, unmaterialised slots and evergreen entries, returning
 * every distinct `(item_id, url)` key they reference. Post and evergreen rows
 * carry one key (the other column is NULL); slot rows carry both id and url.
 * An item is referenced when its id is in
 * `item_id` or its `file_url` is in `url`, which is what the three per-source
 * predicates above test per item (same JSON paths, same workspace scoping,
 * same `post_id IS NULL` rule for slots). `itemReferencedSql` stays the test
 * for one item (`/usage`, purge); a DB spec keeps the two in agreement.
 */
export function workspaceReferenceKeysSql(workspaceId: string): SQL {
  const ws = sql`${workspaceId}::uuid`;
  const str = (v: SQL) =>
    sql`CASE WHEN jsonb_typeof(${v}) = 'string' THEN ${v} #>> '{}' END`;
  // Same document and lax traversal as evergreenRefSql, so a malformed shape
  // (an id inside an array, media nested in an array) matches in both forms.
  const evergreenDoc = sql`jsonb_build_object('media', e.content->'media', 'variations', e.variations)`;
  return sql`
    SELECT e #>> '{}' AS item_id, NULL::text AS url
      FROM posts p, jsonb_array_elements(p.library_refs) e
     WHERE p.workspace_id = ${ws} AND jsonb_typeof(e) = 'string'
    UNION
    SELECT NULL::text, e #>> '{}'
      FROM posts p, jsonb_array_elements(p.media_urls) e
     WHERE p.workspace_id = ${ws} AND jsonb_typeof(e) = 'string'
    UNION
    SELECT ${str(sql`m->'id'`)}, ${str(sql`m->'url'`)}
      FROM campaign_slot_content s
      JOIN campaigns c ON c.id = s.campaign_id,
      jsonb_array_elements(CASE WHEN jsonb_typeof(s.content->'media') = 'array' THEN s.content->'media' ELSE '[]'::jsonb END) m
     WHERE c.workspace_id = ${ws} AND s.post_id IS NULL
    UNION
    SELECT v #>> '{}', NULL::text
      FROM campaign_evergreen_posts e
      JOIN campaigns c ON c.id = e.campaign_id,
      jsonb_path_query(${evergreenDoc}, 'lax $.**.media[*].id[*] ? (@.type() == "string")') v
     WHERE c.workspace_id = ${ws}
    UNION
    SELECT NULL::text, v #>> '{}'
      FROM campaign_evergreen_posts e
      JOIN campaigns c ON c.id = e.campaign_id,
      jsonb_path_query(${evergreenDoc}, 'lax $.**.media[*].url[*] ? (@.type() == "string")') v
     WHERE c.workspace_id = ${ws}
  `;
}

/**
 * "This item is in the reference keys": the stats-side test of
 * `workspaceReferenceKeysSql` rows, exposed so the service and the agreement
 * spec run the same expression. `keys` is the alias of a CTE built from the
 * keys builder.
 */
export function itemInReferenceKeysSql(
  item: Pick<UsageItemRef, 'id' | 'fileUrl'>,
  keys = 'keys',
): SQL {
  const k = sql.raw(keys);
  return sql`((${item.id})::text IN (SELECT item_id FROM ${k} WHERE item_id IS NOT NULL) OR (${item.fileUrl})::text IN (SELECT url FROM ${k} WHERE url IS NOT NULL))`;
}

/** A post's status as a usage entry shows it. */
export function usageStatusOfPost(status: string): UsageEntry['status'] {
  switch (status) {
    case 'draft':
      return 'draft';
    case 'scheduled':
    case 'publishing':
      return 'scheduled';
    case 'published':
    case 'partially_published':
      return 'published';
    case 'failed':
      return 'failed';
    default:
      return 'draft';
  }
}

/** A campaign slot's status as a usage entry shows it (B16). */
export function usageStatusOfSlot(status: string): UsageEntry['status'] {
  switch (status) {
    case 'pending':
    case 'scheduled':
    case 'publishing':
      return 'scheduled';
    case 'published':
      return 'published';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'draft';
    default:
      return 'draft';
  }
}
