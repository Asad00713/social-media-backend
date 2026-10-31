import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
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
const idText = (item: UsageItemRef) => sql`(${item.id})::text`;
const urlText = (item: UsageItemRef) => sql`(${item.fileUrl})::text`;
const wsUuid = (item: UsageItemRef) => sql`(${item.workspaceId})::uuid`;

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
