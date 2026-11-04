import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';

/** A canonical uuid, as Postgres's own text form or upper case. */
const UUID_RE =
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

interface TagRow {
  post_id: string;
  tags: unknown;
}

/**
 * A post's topics: the Library tags of the media it used. A post refers to a
 * media item by id (`library_refs`, picked from the Library) or by URL
 * (`media_urls`: legacy posts, pasted URLs). Imported and text-only posts
 * have neither, so they are always Untagged.
 */
@Injectable()
export class InsightsTopicsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /**
   * Each given post's tags, keyed by post id; posts with none are absent.
   * Both sides are held to `workspaceId`, so neither another workspace's post
   * nor its media item can match. A ref that isn't a uuid is never cast (the
   * CASE yields null), so it matches nothing instead of failing the query. A
   * deleted (recycle-bin) item keeps its tags: the post still used it.
   *
   * Two equality joins, by URL and by id, not one join on `url IN … OR id IN
   * …`: the OR form can only compare every post with every tagged item of the
   * workspace (14 s for 400 posts × 2,000 items locally; this form, 39 ms).
   * An item matched both ways comes back twice; its tags are merged.
   */
  async tagsByPost(
    workspaceId: string,
    postIds: string[],
  ): Promise<Map<string, string[]>> {
    const byPost = new Map<string, string[]>();
    if (!postIds.length) return byPost;
    const tagged = sql`CASE WHEN jsonb_typeof(mi.tags) = 'array'
      THEN jsonb_array_length(mi.tags) ELSE 0 END > 0`;
    // The ids go as ONE array parameter, read once by the CTE for both
    // branches. One `$n::uuid` per id per branch would hit Postgres's
    // 65,535-parameter cap at about 32,000 posts.
    const result = await this.db.execute(sql`
      WITH p AS (
        SELECT id, workspace_id, media_urls, library_refs
        FROM posts
        WHERE workspace_id = ${workspaceId}
          AND id = ANY(${sql.param(postIds)}::uuid[])
      )
      SELECT p.id AS post_id, mi.tags
      FROM p
      CROSS JOIN LATERAL jsonb_array_elements_text(p.media_urls) AS u(url)
      JOIN media_items mi ON mi.workspace_id = p.workspace_id
        AND mi.file_url = u.url
      WHERE ${tagged}
      UNION ALL
      SELECT p.id, mi.tags
      FROM p
      CROSS JOIN LATERAL jsonb_array_elements_text(p.library_refs) AS r(ref)
      JOIN media_items mi ON mi.workspace_id = p.workspace_id
        AND mi.id = CASE WHEN r.ref ~* ${UUID_RE} THEN r.ref::uuid END
      WHERE ${tagged}
    `);

    for (const row of result.rows as unknown as TagRow[]) {
      const tags = Array.isArray(row.tags)
        ? row.tags.filter((t): t is string => typeof t === 'string')
        : [];
      const list = byPost.get(row.post_id) ?? [];
      for (const tag of tags) if (!list.includes(tag)) list.push(tag);
      if (list.length) byPost.set(row.post_id, list);
    }
    return byPost;
  }
}
