import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import {
  mediaItems,
  mediaTemplates,
  savedLinks,
  textSnippets,
} from '../../drizzle/schema/media-library.schema';
import { toUserRef } from '../lib/user-ref';
import type { MediaType } from '../lib/folder-kind';
import {
  BIN_KINDS,
  type BinKind,
  type BinRow,
  type Page,
} from '../dto/contract';
import type {
  BinItemRefDto,
  BinSort,
  RecycleBinQueryDto,
} from '../dto/media-library.dto';
import { MediaItemService } from './media-item.service';

/** How long a row stays in the Bin; matches `cleanupRecycleBin`. */
const BIN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** The templates, snippets and links tables, by Bin kind. */
const KIND_TABLES = {
  template: mediaTemplates,
  snippet: textSnippets,
  link: savedLinks,
} as const;

export type BinPage = Page<BinRow> & { countsByKind: Record<BinKind, number> };

/** Which branches of the Bin a query reads. */
interface BinScope {
  kinds: BinKind[];
  /** A legacy `type` of image|video|gif|document narrows media to it. */
  mediaType?: MediaType;
}

interface BinRowSql extends Record<string, unknown> {
  kind: BinKind;
  id: string;
  name: string;
  thumbnail_url: string | null;
  type: string;
  size_bytes: number | null;
  deleted_ms: number;
  user_id: string | null;
  user_name: string | null;
  user_email: string | null;
  user_avatar_url: string | null;
}

interface BinCountsSql extends Record<string, unknown> {
  media: number;
  media_scoped: number;
  template: number;
  snippet: number;
  link: number;
}

/** An explicit `kind` wins; else the legacy `type` maps to one (B12). */
function binScope(query: RecycleBinQueryDto): BinScope {
  if (query.kind) return { kinds: [query.kind] };
  switch (query.type) {
    case undefined:
      return { kinds: [...BIN_KINDS] };
    case 'template':
      return { kinds: ['template'] };
    case 'text_snippet':
      return { kinds: ['snippet'] };
    case 'link':
      return { kinds: ['link'] };
    default:
      return { kinds: ['media'], mediaType: query.type };
  }
}

function binOrder(sort: BinSort): SQL {
  switch (sort) {
    case 'name':
      return sql`lower(b.name) ASC, b.id ASC`;
    case 'size':
      return sql`b.size_bytes DESC NULLS LAST, b.deleted_at DESC, b.id ASC`;
    case 'deleted':
      return sql`b.deleted_at DESC, b.id ASC`;
  }
}

/** Groups Bin refs by kind, ids de-duplicated. */
function idsByKind(items: BinItemRefDto[]): Map<BinKind, string[]> {
  const sets = new Map<BinKind, Set<string>>();
  for (const { kind, id } of items) {
    const set = sets.get(kind) ?? new Set<string>();
    set.add(id);
    sets.set(kind, set);
  }
  return new Map([...sets].map(([kind, ids]) => [kind, [...ids]]));
}

@Injectable()
export class RecycleBinService {
  private readonly logger = new Logger(RecycleBinService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly mediaItems: MediaItemService,
  ) {}

  /**
   * The Bin across all four kinds, as one `UNION ALL`. The kind (or legacy
   * type) filter drops branches inside the union, so it applies before
   * ORDER BY / LIMIT / OFFSET. `countsByKind` ignores that filter.
   */
  async list(
    workspaceId: string,
    query: RecycleBinQueryDto = {},
  ): Promise<BinPage> {
    const { sort = 'deleted', limit = 50, offset = 0 } = query;
    const scope = binScope(query);
    const ws = sql`${workspaceId}::uuid`;
    const binned = sql`workspace_id = ${ws} AND is_deleted = true`;
    const mediaTypeFilter = scope.mediaType
      ? sql`AND type = ${scope.mediaType}`
      : sql``;
    // A row binned before deleted_at was recorded falls back to updated_at.
    const deletedAt = sql`COALESCE(deleted_at, updated_at)`;

    // Every branch names its columns: with a kind filter, any of them can be
    // the first (and so the naming) branch of the union.
    const tail = sql`${deletedAt} AS deleted_at, deleted_by_id`;
    const branches: Record<BinKind, SQL> = {
      media: sql`
        SELECT 'media' AS kind, id, name,
               COALESCE(thumbnail_url,
                        CASE WHEN type IN ('image', 'gif') THEN file_url END)
                 AS thumbnail_url,
               type::text AS type, file_size AS size_bytes, ${tail}
          FROM media_items
         WHERE ${binned} ${mediaTypeFilter}`,
      template: sql`
        SELECT 'template' AS kind, id, name, thumbnail_url,
               'template' AS type, NULL::bigint AS size_bytes, ${tail}
          FROM media_templates WHERE ${binned}`,
      snippet: sql`
        SELECT 'snippet' AS kind, id, name, NULL::text AS thumbnail_url,
               'snippet' AS type, NULL::bigint AS size_bytes, ${tail}
          FROM text_snippets WHERE ${binned}`,
      link: sql`
        SELECT 'link' AS kind, id, name, preview_image_url AS thumbnail_url,
               'link' AS type, NULL::bigint AS size_bytes, ${tail}
          FROM saved_links WHERE ${binned}`,
    };
    const union = sql.join(
      scope.kinds.map((k) => branches[k]),
      sql` UNION ALL `,
    );

    const page = await this.db.execute<BinRowSql>(sql`
      SELECT b.kind, b.id, b.name, b.thumbnail_url, b.type,
             b.size_bytes::float8 AS size_bytes,
             (extract(epoch FROM b.deleted_at) * 1000)::float8 AS deleted_ms,
             u.id AS user_id, u.name AS user_name, u.email AS user_email,
             u.avatar_url AS user_avatar_url
        FROM (${union}) b
        LEFT JOIN users u ON u.id = b.deleted_by_id
       ORDER BY ${binOrder(sort)}
       LIMIT ${limit} OFFSET ${offset}
    `);

    const counts = await this.db.execute<BinCountsSql>(sql`
      SELECT
        (SELECT count(*) FROM media_items WHERE ${binned})::int AS media,
        (SELECT count(*) FROM media_items WHERE ${binned} ${mediaTypeFilter}
        )::int AS media_scoped,
        (SELECT count(*) FROM media_templates WHERE ${binned})::int AS template,
        (SELECT count(*) FROM text_snippets WHERE ${binned})::int AS snippet,
        (SELECT count(*) FROM saved_links WHERE ${binned})::int AS link
    `);
    const c = counts.rows[0];
    const countsByKind: Record<BinKind, number> = {
      media: c.media,
      template: c.template,
      snippet: c.snippet,
      link: c.link,
    };
    const total = scope.kinds.reduce(
      (sum, k) => sum + (k === 'media' ? c.media_scoped : countsByKind[k]),
      0,
    );

    return {
      items: page.rows.map(toBinRow),
      total,
      limit,
      offset,
      countsByKind,
    };
  }

  /**
   * Restores the named rows. Only rows of this workspace that are in the Bin
   * change; anything else (live, another workspace, wrong kind) is skipped
   * and not counted.
   */
  async restore(
    workspaceId: string,
    items: BinItemRefDto[],
  ): Promise<{ restored: number }> {
    const cleared = {
      isDeleted: false,
      deletedAt: null,
      deletedById: null,
      updatedAt: new Date(),
    };
    let restored = 0;
    for (const [kind, ids] of idsByKind(items)) {
      const table = kind === 'media' ? mediaItems : KIND_TABLES[kind];
      const rows = await this.db
        .update(table)
        .set(cleared)
        .where(
          and(
            eq(table.workspaceId, workspaceId),
            eq(table.isDeleted, true),
            inArray(table.id, ids),
          ),
        )
        .returning({ id: table.id });
      restored += rows.length;
    }
    return { restored };
  }

  /**
   * Permanently deletes the named rows, only those of this workspace that are
   * in the Bin. Media goes through the purge (files first; a row whose file
   * will not delete stays in the Bin), the other kinds in one DELETE each.
   */
  async deleteForever(
    workspaceId: string,
    items: BinItemRefDto[],
  ): Promise<{ deleted: number }> {
    let deleted = 0;
    for (const [kind, ids] of idsByKind(items)) {
      if (kind === 'media') {
        deleted += await this.purgeMedia(workspaceId, ids);
        continue;
      }
      const table = KIND_TABLES[kind];
      const rows = await this.db
        .delete(table)
        .where(
          and(
            eq(table.workspaceId, workspaceId),
            eq(table.isDeleted, true),
            inArray(table.id, ids),
          ),
        )
        .returning({ id: table.id });
      deleted += rows.length;
    }
    return { deleted };
  }

  private async purgeMedia(workspaceId: string, ids: string[]) {
    const rows = await this.db
      .select()
      .from(mediaItems)
      .where(
        and(
          eq(mediaItems.workspaceId, workspaceId),
          eq(mediaItems.isDeleted, true),
          inArray(mediaItems.id, ids),
        ),
      );
    const { deletedIds, failedIds } = await this.mediaItems.purgeItems(rows);
    if (failedIds.length > 0) {
      this.logger.warn(
        `Deleting from bin of workspace ${workspaceId}: ${failedIds.length} media items kept (file deletion failed)`,
      );
    }
    return deletedIds.length;
  }

  /**
   * Permanently deletes everything in the workspace's bin. Media goes through
   * the batched purge (files first, then rows), so rows whose file will not
   * delete stay in the bin and a retry picks them up. The other kinds have no
   * file behind them and go in one statement each.
   */
  async empty(workspaceId: string): Promise<{ deleted: number }> {
    const media = await this.mediaItems.purgeDeleted({ workspaceId });
    if (media.failed > 0) {
      this.logger.warn(
        `Emptying bin of workspace ${workspaceId}: ${media.failed} media items kept (file deletion failed)`,
      );
    }

    const templates = await this.db
      .delete(mediaTemplates)
      .where(
        and(
          eq(mediaTemplates.workspaceId, workspaceId),
          eq(mediaTemplates.isDeleted, true),
        ),
      )
      .returning({ id: mediaTemplates.id });
    const snippets = await this.db
      .delete(textSnippets)
      .where(
        and(
          eq(textSnippets.workspaceId, workspaceId),
          eq(textSnippets.isDeleted, true),
        ),
      )
      .returning({ id: textSnippets.id });
    const links = await this.db
      .delete(savedLinks)
      .where(
        and(
          eq(savedLinks.workspaceId, workspaceId),
          eq(savedLinks.isDeleted, true),
        ),
      )
      .returning({ id: savedLinks.id });

    return {
      deleted:
        media.deleted + templates.length + snippets.length + links.length,
    };
  }
}

function toBinRow(r: BinRowSql): BinRow {
  const deletedMs = Number(r.deleted_ms);
  return {
    kind: r.kind,
    id: r.id,
    name: r.name,
    thumbnailUrl: r.thumbnail_url,
    type: r.type,
    sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
    deletedAt: new Date(deletedMs).toISOString(),
    deletedBy: toUserRef(
      r.user_id
        ? {
            id: r.user_id,
            name: r.user_name,
            email: r.user_email ?? '',
            avatarUrl: r.user_avatar_url,
          }
        : null,
    ),
    purgeAt: new Date(deletedMs + BIN_RETENTION_MS).toISOString(),
  };
}
