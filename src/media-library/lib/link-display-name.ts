import { sql, type SQL } from 'drizzle-orm';

/**
 * The one display name of a saved link: its name, else its fetched page title,
 * else its URL. The Save link form has no Name field, so `name` is often
 * blank. The Bin list and the link `name` sort both use this, so a blank-named
 * link shows (and sorts) under what the card prints.
 */
export function linkDisplayNameSql(
  name: SQL | object,
  previewTitle: SQL | object,
  url: SQL | object,
): SQL {
  return sql`COALESCE(NULLIF(btrim(${name}), ''), NULLIF(btrim(${previewTitle}), ''), ${url})`;
}

/** The same rule over `saved_links` columns by their raw SQL names. */
export const SAVED_LINK_DISPLAY_NAME_SQL: SQL = linkDisplayNameSql(
  sql.raw('name'),
  sql.raw('preview_title'),
  sql.raw('url'),
);
