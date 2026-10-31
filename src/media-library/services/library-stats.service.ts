import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { LibraryStats } from '../dto/contract';
import { storageLevel, storagePercent } from '../lib/storage';
import {
  itemInReferenceKeysSql,
  workspaceReferenceKeysSql,
} from '../lib/usage-sql';
import { StorageQuotaService } from './storage-quota.service';

/** Every column of the stats statements is a count, a byte sum or a bigint. */
type Row = Record<string, number | string | null>;

/** One call for the chips, the storage popover and the banners. */
@Injectable()
export class LibraryStatsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly quota: StorageQuotaService,
  ) {}

  async getStats(workspaceId: string): Promise<LibraryStats> {
    // One read-only REPEATABLE READ snapshot, so used bytes, the counts and
    // the bin cannot disagree with each other mid-upload. The statements run
    // one after another on purpose: a transaction is a single connection.
    return this.db.transaction(
      async (tx) => this.collect(tx as unknown as DbType, workspaceId),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  private async collect(
    db: DbType,
    workspaceId: string,
  ): Promise<LibraryStats> {
    const ws = sql`${workspaceId}::uuid`;
    const live = sql`NOT COALESCE(is_deleted, false)`;
    const binned = sql`COALESCE(is_deleted, false)`;
    const size = sql`COALESCE(file_size, 0)`;
    const isImage = sql`type IN ('image', 'gif')`;

    // `ref` (is the item used anywhere) is computed once per item, from one
    // set-based pass over the workspace's references. MATERIALIZED, or the
    // planner inlines `m` and repeats the test in every FILTER.
    const media = await db.execute<Row>(sql`
      WITH keys AS MATERIALIZED (${workspaceReferenceKeysSql(workspaceId)}),
      m AS MATERIALIZED (
        SELECT type, file_size, is_deleted,
               ${itemInReferenceKeysSql({ id: sql`id`, fileUrl: sql`file_url` })} AS ref
          FROM media_items WHERE workspace_id = ${ws}
      )
      SELECT
        COUNT(*) FILTER (WHERE ${live})::int AS "all",
        COUNT(*) FILTER (WHERE ${live} AND ${isImage})::int AS images,
        COUNT(*) FILTER (WHERE ${live} AND type = 'video')::int AS videos,
        COUNT(*) FILTER (WHERE ${live} AND type = 'document')::int AS docs,
        COALESCE(SUM(${size}) FILTER (WHERE ${live} AND ${isImage}), 0)::float8 AS images_bytes,
        COALESCE(SUM(${size}) FILTER (WHERE ${live} AND type = 'video'), 0)::float8 AS videos_bytes,
        COALESCE(SUM(${size}) FILTER (WHERE ${live} AND type = 'document'), 0)::float8 AS docs_bytes,
        COUNT(*) FILTER (WHERE ${live} AND NOT ref)::int AS unused_count,
        COALESCE(SUM(${size}) FILTER (WHERE ${live} AND NOT ref), 0)::float8 AS unused_bytes,
        COUNT(*) FILTER (WHERE ${binned})::int AS bin_count,
        COALESCE(SUM(${size}) FILTER (WHERE ${binned}), 0)::float8 AS bin_bytes
      FROM m
    `);
    const templates = await db.execute<Row>(sql`
          SELECT
            COUNT(*) FILTER (WHERE ${live})::int AS "all",
            COUNT(*) FILTER (WHERE ${live} AND template_type = 'post')::int AS post,
            COUNT(*) FILTER (WHERE ${live} AND template_type = 'story')::int AS story,
            COUNT(*) FILTER (WHERE ${live} AND template_type = 'reel')::int AS reel,
            COUNT(*) FILTER (WHERE ${live} AND template_type = 'carousel')::int AS carousel,
            COUNT(*) FILTER (WHERE ${binned})::int AS bin_count
          FROM media_templates WHERE workspace_id = ${ws}
        `);
    const snippets = await db.execute<Row>(sql`
          SELECT
            COUNT(*) FILTER (WHERE ${live})::int AS "all",
            COUNT(*) FILTER (WHERE ${live} AND snippet_type = 'caption')::int AS caption,
            COUNT(*) FILTER (WHERE ${live} AND snippet_type = 'hashtags')::int AS hashtags,
            COUNT(*) FILTER (WHERE ${live} AND snippet_type = 'cta')::int AS cta,
            COUNT(*) FILTER (WHERE ${live} AND snippet_type = 'signature')::int AS signature,
            COUNT(*) FILTER (WHERE ${binned})::int AS bin_count
          FROM text_snippets WHERE workspace_id = ${ws}
        `);
    const links = await db.execute<Row>(sql`
          SELECT
            COUNT(*) FILTER (WHERE ${live})::int AS "all",
            COUNT(*) FILTER (WHERE ${binned})::int AS bin_count
          FROM saved_links WHERE workspace_id = ${ws}
        `);
    const folders = await db.execute<Row>(sql`
          SELECT
            COUNT(*) FILTER (WHERE type = 'media')::int AS media,
            COUNT(*) FILTER (WHERE type = 'template')::int AS template,
            COUNT(*) FILTER (WHERE type = 'text_snippet')::int AS text_snippet,
            COUNT(*) FILTER (WHERE type = 'link')::int AS link
          FROM media_categories WHERE workspace_id = ${ws}
        `);
    const usage = await this.quota.getUsage(workspaceId, db);

    const m = media.rows[0];
    const t = templates.rows[0];
    const s = snippets.rows[0];
    const l = links.rows[0];
    const f = folders.rows[0];
    const n = (v: unknown) => Number(v ?? 0);

    return {
      storage: {
        used: usage.used,
        limit: usage.limit,
        percent: storagePercent(usage.used, usage.limit),
        level: storageLevel(usage.used, usage.limit),
        byType: {
          images: n(m.images_bytes),
          videos: n(m.videos_bytes),
          docs: n(m.docs_bytes),
        },
      },
      unused: { count: n(m.unused_count), bytes: n(m.unused_bytes) },
      bin: {
        count:
          n(m.bin_count) + n(t.bin_count) + n(s.bin_count) + n(l.bin_count),
        bytes: n(m.bin_bytes),
      },
      counts: {
        media: {
          all: n(m.all),
          images: n(m.images),
          videos: n(m.videos),
          docs: n(m.docs),
        },
        templates: {
          all: n(t.all),
          post: n(t.post),
          story: n(t.story),
          reel: n(t.reel),
          carousel: n(t.carousel),
        },
        snippets: {
          all: n(s.all),
          caption: n(s.caption),
          hashtags: n(s.hashtags),
          cta: n(s.cta),
          signature: n(s.signature),
        },
        links: n(l.all),
        folders: {
          media: n(f.media),
          template: n(f.template),
          text_snippet: n(f.text_snippet),
          link: n(f.link),
        },
      },
    };
  }
}
