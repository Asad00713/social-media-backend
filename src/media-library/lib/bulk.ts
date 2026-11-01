import { BadRequestException, Logger } from '@nestjs/common';
import { and, eq, inArray, type SQL } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import {
  mediaCategories,
  mediaTemplates,
  savedLinks,
  textSnippets,
} from '../../drizzle/schema/media-library.schema';
import type { KindBulkAction } from '../dto/media-library.dto';
import type { FolderKind } from './folder-kind';

/** Rows touched per statement by a bulk action. */
export const BULK_CHUNK = 500;

const logger = new Logger('LibraryBulk');

/**
 * A bulk request names its rows one way: an explicit `ids` list, or
 * `selectAll` with the list's filter. Both, or neither, is a 400. `null`
 * counts as absent.
 */
export function assertIdsXorSelectAll(dto: {
  ids?: string[] | null;
  selectAll?: unknown;
}): void {
  const hasIds = dto.ids != null;
  const hasSelectAll = dto.selectAll != null;
  if (hasIds === hasSelectAll) {
    throw new BadRequestException('Send ids or selectAll, not both');
  }
}

/**
 * Whether a bulk action works on binned rows (`true`: restore and
 * permanentDelete) or on live rows (`false`: everything else). The action
 * decides, never the client's filter: a filter's `isDeleted` must not turn
 * "star everything" into "purge everything".
 *
 * A select-all restore or permanentDelete is refused; the Bin has its own
 * endpoints for that.
 */
export function bulkTargetsBin(dto: {
  action: string;
  selectAll?: unknown;
}): boolean {
  const inBin = dto.action === 'restore' || dto.action === 'permanentDelete';
  if (inBin && dto.selectAll != null) {
    throw new BadRequestException(
      'Use the Bin to restore or delete permanently',
    );
  }
  return inBin;
}

/** Splits `xs` into consecutive runs of at most `size`. */
export function chunk<T>(xs: T[], size = BULK_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) {
    out.push(xs.slice(i, i + size));
  }
  return out;
}

/**
 * A template, snippet or link may be filed only into one of this workspace's
 * folders of its own kind. Shared by create, update and bulk move.
 */
export async function assertKindFolder(
  db: DbType,
  workspaceId: string,
  categoryId: string,
  folderKind: FolderKind,
  label: string,
): Promise<void> {
  const [folder] = await db
    .select({ id: mediaCategories.id })
    .from(mediaCategories)
    .where(
      and(
        eq(mediaCategories.id, categoryId),
        eq(mediaCategories.workspaceId, workspaceId),
        eq(mediaCategories.type, folderKind),
      ),
    )
    .limit(1);
  if (!folder) {
    throw new BadRequestException(`${label} category not found`);
  }
}

export type KindTable =
  | typeof mediaTemplates
  | typeof textSnippets
  | typeof savedLinks;

export interface KindBulkConfig {
  table: KindTable;
  folderKind: Exclude<FolderKind, 'media'>;
  /** Singular, capitalised: 'Template', 'Text snippet', 'Link'. */
  label: string;
}

export interface KindBulkRequest<F> {
  ids?: string[] | null;
  selectAll?: { filter: F } | null;
  action: KindBulkAction;
  categoryId?: string | null;
}

/**
 * Bulk delete / star / unstar / move for templates, snippets and links
 * (ruling 6), on `ids` or with `selectAll` on every row the list's filter
 * matches. These actions act on live rows only (`bulkTargetsBin`).
 *
 * - `delete` soft-deletes (`is_deleted`, `deleted_at`, `deleted_by_id`).
 * - `move` needs `categoryId`: null unfiles, an id must be a folder of this
 *   kind (X1).
 * - Explicit ids outside the workspace are a 400. Ids in the workspace but
 *   in the Bin are skipped, and `affectedCount` counts only changed rows.
 */
export async function runKindBulk<F extends { isDeleted?: boolean }>(
  db: DbType,
  cfg: KindBulkConfig,
  workspaceId: string,
  userId: string,
  dto: KindBulkRequest<F>,
  buildConditions: (workspaceId: string, filter: F) => SQL[],
): Promise<{ affectedCount: number }> {
  assertIdsXorSelectAll(dto);
  const inBin = bulkTargetsBin(dto);
  const { table } = cfg;

  if (dto.action === 'move') {
    // Omitted is not a move; null is: it unfiles the selection (X1).
    if (dto.categoryId === undefined) {
      throw new BadRequestException('categoryId required for move action');
    }
    if (dto.categoryId !== null) {
      await assertKindFolder(
        db,
        workspaceId,
        dto.categoryId,
        cfg.folderKind,
        cfg.label,
      );
    }
  }

  let ids: string[];
  if (dto.selectAll != null) {
    // The action, not the filter, says bin or live.
    const filter = { ...dto.selectAll.filter, isDeleted: inBin };
    const rows = await db
      .select({ id: table.id })
      .from(table)
      .where(and(...buildConditions(workspaceId, filter)));
    ids = rows.map((r) => r.id);
  } else {
    // A repeated id names one row: de-duplicated before the "not found"
    // count, as the Bin's idsByKind does (M10).
    ids = [...new Set(dto.ids ?? [])];
    if (ids.length > 0) {
      const found = await db
        .select({ id: table.id })
        .from(table)
        .where(and(inArray(table.id, ids), eq(table.workspaceId, workspaceId)));
      if (found.length !== ids.length) {
        throw new BadRequestException('Some items not found');
      }
    }
  }

  const now = new Date();
  const set =
    dto.action === 'delete'
      ? { isDeleted: true, deletedAt: now, deletedById: userId }
      : dto.action === 'move'
        ? { categoryId: dto.categoryId ?? null }
        : { isStarred: dto.action === 'star' };

  // Chunks are separate statements, not one transaction: a failure midway
  // leaves the earlier chunks applied. Every action is idempotent (it sets a
  // flag or a folder), so retrying the same request converges.
  let affectedCount = 0;
  for (const part of chunk(ids)) {
    const rows = await db
      .update(table)
      .set({ ...set, updatedAt: now })
      .where(
        and(
          inArray(table.id, part),
          eq(table.workspaceId, workspaceId),
          eq(table.isDeleted, inBin),
        ),
      )
      .returning({ id: table.id });
    affectedCount += rows.length;
  }

  logger.log(
    `Bulk ${dto.action} on ${ids.length} ${cfg.label.toLowerCase()} rows in workspace ${workspaceId}`,
  );

  return { affectedCount };
}
