import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  BadGatewayException,
} from '@nestjs/common';
import {
  eq,
  and,
  desc,
  asc,
  ilike,
  sql,
  inArray,
  gt,
  gte,
  lt,
  not,
  type SQL,
} from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import {
  mediaItems,
  mediaCategories,
  NewMediaItem,
  MediaLibraryItem,
  MediaCategory,
} from '../../drizzle/schema/media-library.schema';
import { users } from '../../drizzle/schema/users.schema';
import { ilikePattern } from '../lib/search';
import { itemReferencedSql } from '../lib/usage-sql';
import { ratioBounds } from '../lib/ratio';
import { toUserRef } from '../lib/user-ref';
import { assertIdsXorSelectAll, bulkTargetsBin, chunk } from '../lib/bulk';
import type { Page, UserRef } from '../dto/contract';
import { CloudinaryService } from '../../media/cloudinary.service';
import { StorageObjectService } from './storage-object.service';
import {
  CreateMediaItemDto,
  UpdateMediaItemDto,
  MediaItemQueryDto,
  BulkActionDto,
} from '../dto/media-library.dto';

/** A media item as the list and the Preview read it. */
export type MediaItemView = MediaLibraryItem & {
  category: MediaCategory | null;
  uploadedBy: UserRef | null;
};

/** Files deleted from storage at once during a purge. */
const PURGE_CONCURRENCY = 8;
/** Rows read per page when purging the bin. */
const PURGE_BATCH = 200;
/** Rows deleted per statement, to stay far below the parameter limit. */
const DELETE_CHUNK = 1000;
const BIN_RETENTION_DAYS = 30;

@Injectable()
export class MediaItemService {
  private readonly logger = new Logger(MediaItemService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly cloudinaryService: CloudinaryService,
    private readonly storageObjects: StorageObjectService,
  ) {}

  /**
   * An item may be filed only into a media folder. Template, snippet and link
   * folders hold other kinds of thing. Also the guard for uploads.
   */
  async assertMediaFolder(
    workspaceId: string,
    categoryId: string,
  ): Promise<void> {
    const [folder] = await this.db
      .select({ name: mediaCategories.name, type: mediaCategories.type })
      .from(mediaCategories)
      .where(
        and(
          eq(mediaCategories.id, categoryId),
          eq(mediaCategories.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (!folder) {
      throw new NotFoundException('Folder not found');
    }
    if (folder.type !== 'media') {
      throw new BadRequestException(
        `Folder "${folder.name}" is not a media folder`,
      );
    }
  }

  /**
   * Create a new media item
   */
  async create(workspaceId: string, userId: string, dto: CreateMediaItemDto) {
    if (dto.categoryId) {
      await this.assertMediaFolder(workspaceId, dto.categoryId);
    }

    const newItem: NewMediaItem = {
      workspaceId,
      uploadedById: userId,
      type: dto.type,
      name: dto.name,
      description: dto.description,
      fileUrl: dto.fileUrl,
      thumbnailUrl: dto.thumbnailUrl,
      mimeType: dto.mimeType,
      fileSize: dto.fileSize,
      width: dto.width,
      height: dto.height,
      duration: dto.duration,
      cloudinaryPublicId: dto.cloudinaryPublicId,
      cloudinaryAssetId: dto.cloudinaryAssetId,
      storageProvider: this.storageObjects.providerOf(
        dto.fileUrl,
        dto.cloudinaryPublicId ?? null,
      ),
      categoryId: dto.categoryId,
      tags: dto.tags || [],
      altText: dto.altText,
      pageCount: dto.pageCount,
    };

    const [created] = await this.db
      .insert(mediaItems)
      .values(newItem)
      .returning();

    this.logger.log(
      `Created media item "${dto.name}" for workspace ${workspaceId}`,
    );

    return created;
  }

  /**
   * The WHERE clause of `GET items`, shared with bulk select-all so "every
   * match" means exactly what the list shows. Ignores `limit`, `offset` and
   * the sort.
   */
  buildItemConditions(workspaceId: string, query: MediaItemQueryDto): SQL[] {
    const {
      type,
      categoryId,
      isDeleted = false,
      search,
      tags,
      gifOnly,
      ratio,
      addedSince,
      uploadedBy,
      neverUsed,
    } = query;
    // `starred` is the contract name and wins over the legacy `isStarred`.
    const starred = query.starred ?? query.isStarred;

    const conditions: SQL[] = [
      eq(mediaItems.workspaceId, workspaceId),
      eq(mediaItems.isDeleted, isDeleted),
    ];

    if (type === 'images') {
      conditions.push(inArray(mediaItems.type, ['image', 'gif']));
    } else if (type) {
      conditions.push(eq(mediaItems.type, type));
    }

    if (gifOnly) {
      conditions.push(eq(mediaItems.type, 'gif'));
    }

    if (categoryId) {
      conditions.push(eq(mediaItems.categoryId, categoryId));
    }

    if (starred !== undefined) {
      conditions.push(eq(mediaItems.isStarred, starred));
    }

    if (search) {
      conditions.push(ilike(mediaItems.name, ilikePattern(search)));
    }

    if (tags && tags.length > 0) {
      conditions.push(
        sql`${mediaItems.tags} @> ${JSON.stringify(tags)}::jsonb`,
      );
    }

    if (ratio) {
      // Multiplied out (width >= min × height) so no row divides by zero.
      // The bounds are cast because a bare parameter next to an integer
      // column would be read as an integer.
      const { min, max } = ratioBounds(ratio);
      conditions.push(
        sql`(${mediaItems.width} > 0 AND ${mediaItems.height} > 0 AND ${mediaItems.width} >= ${min}::float8 * ${mediaItems.height} AND ${mediaItems.width} <= ${max}::float8 * ${mediaItems.height})`,
      );
    }

    if (addedSince) {
      // ISO 8601 allows forms Date cannot read (2026-W05, 2026-123); those
      // are a bad request, not an Invalid Date reaching Postgres as a 500.
      const since = new Date(addedSince);
      if (Number.isNaN(since.getTime())) {
        throw new BadRequestException(
          'addedSince must be a calendar date or date-time',
        );
      }
      conditions.push(gte(mediaItems.createdAt, since));
    }

    if (uploadedBy) {
      conditions.push(eq(mediaItems.uploadedById, uploadedBy));
    }

    if (neverUsed) {
      conditions.push(
        not(
          itemReferencedSql({
            id: mediaItems.id,
            fileUrl: mediaItems.fileUrl,
            workspaceId: mediaItems.workspaceId,
          }),
        ),
      );
    }

    return conditions;
  }

  /**
   * ORDER BY for `GET items`. Every order ends in `id DESC`: without a
   * deterministic tiebreaker Postgres returns ties in heap order, and an
   * UPDATE (starring an asset) moves the tuple to the end of the heap, so the
   * starred image jumped to the bottom of the grid.
   */
  private itemOrder(query: MediaItemQueryDto): SQL[] {
    const byNewest = [desc(mediaItems.createdAt), desc(mediaItems.id)];

    switch (query.sort) {
      case 'newest':
        return byNewest;
      case 'oldest':
        return [asc(mediaItems.createdAt), asc(mediaItems.id)];
      case 'most_used':
        return [sql`${mediaItems.usageCount} DESC NULLS LAST`, ...byNewest];
      case 'recently_used':
        return [sql`${mediaItems.lastUsedAt} DESC NULLS LAST`, ...byNewest];
      case 'name':
        return [sql`lower(${mediaItems.name}) ASC`, ...byNewest];
      case 'size':
        return [sql`${mediaItems.fileSize} DESC NULLS LAST`, ...byNewest];
    }

    // Legacy sortBy/sortOrder, for callers that do not send `sort` yet.
    const { sortBy = 'createdAt', sortOrder = 'desc' } = query;
    const sortColumn = {
      createdAt: mediaItems.createdAt,
      name: mediaItems.name,
      usageCount: mediaItems.usageCount,
      lastUsedAt: mediaItems.lastUsedAt,
    }[sortBy];
    const orderFn = sortOrder === 'asc' ? asc : desc;

    // `lastUsedAt` stays null until an asset is used, so "never used" belongs
    // after everything that has been used. Postgres puts NULLS FIRST for DESC
    // by default, which ranked untouched assets above used ones.
    const primaryOrder =
      sortBy === 'lastUsedAt'
        ? sortOrder === 'asc'
          ? sql`${mediaItems.lastUsedAt} ASC NULLS LAST`
          : sql`${mediaItems.lastUsedAt} DESC NULLS LAST`
        : orderFn(sortColumn);
    return [primaryOrder, ...byNewest];
  }

  /** The columns a `MediaItemView` is read from; uploader left-joined. */
  private viewSelection() {
    return {
      item: mediaItems,
      category: mediaCategories,
      uploader: {
        id: users.id,
        name: users.name,
        email: users.email,
        avatarUrl: users.avatarUrl,
      },
    };
  }

  /**
   * Get all media items for a workspace with filtering
   */
  async findAll(
    workspaceId: string,
    query: MediaItemQueryDto = {},
  ): Promise<Page<MediaItemView>> {
    const { limit = 50, offset = 0 } = query;
    const conditions = this.buildItemConditions(workspaceId, query);

    const rows = await this.db
      .select(this.viewSelection())
      .from(mediaItems)
      .leftJoin(mediaCategories, eq(mediaItems.categoryId, mediaCategories.id))
      .leftJoin(users, eq(mediaItems.uploadedById, users.id))
      .where(and(...conditions))
      .orderBy(...this.itemOrder(query))
      .limit(limit)
      .offset(offset);

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(mediaItems)
      .where(and(...conditions));

    return {
      items: rows.map((row) => ({
        ...row.item,
        category: row.category,
        uploadedBy: toUserRef(row.uploader),
      })),
      total: count,
      limit,
      offset,
    };
  }

  /**
   * Get recently created items
   */
  async findRecent(workspaceId: string, limit = 20) {
    const items = await this.db
      .select()
      .from(mediaItems)
      .where(
        and(
          eq(mediaItems.workspaceId, workspaceId),
          eq(mediaItems.isDeleted, false),
        ),
      )
      .orderBy(desc(mediaItems.createdAt))
      .limit(limit);

    return items;
  }

  /**
   * Get a single media item by ID
   */
  async findOne(workspaceId: string, itemId: string): Promise<MediaItemView> {
    const [row] = await this.db
      .select(this.viewSelection())
      .from(mediaItems)
      .leftJoin(mediaCategories, eq(mediaItems.categoryId, mediaCategories.id))
      .leftJoin(users, eq(mediaItems.uploadedById, users.id))
      .where(
        and(eq(mediaItems.id, itemId), eq(mediaItems.workspaceId, workspaceId)),
      )
      .limit(1);

    if (!row) {
      throw new NotFoundException('Media item not found');
    }

    return {
      ...row.item,
      category: row.category,
      uploadedBy: toUserRef(row.uploader),
    };
  }

  /**
   * Update a media item
   */
  async update(workspaceId: string, itemId: string, dto: UpdateMediaItemDto) {
    const existing = await this.findOne(workspaceId, itemId);

    // Validate category if changing. A null `categoryId` skips this on purpose:
    // it means "take this out of its folder", and there is no target type to
    // match against. `undefined` (field omitted) leaves the folder untouched.
    if (dto.categoryId && dto.categoryId !== existing.categoryId) {
      await this.assertMediaFolder(workspaceId, dto.categoryId);
    }

    const updateData: Partial<typeof mediaItems.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.categoryId !== undefined) updateData.categoryId = dto.categoryId;
    if (dto.tags !== undefined) updateData.tags = dto.tags;
    if (dto.isStarred !== undefined) updateData.isStarred = dto.isStarred;
    if (dto.altText !== undefined) updateData.altText = dto.altText;

    const [updated] = await this.db
      .update(mediaItems)
      .set(updateData)
      .where(eq(mediaItems.id, itemId))
      .returning();

    this.logger.log(`Updated media item ${itemId}`);

    return updated;
  }

  /**
   * Soft delete a media item (move to recycle bin)
   */
  async softDelete(workspaceId: string, itemId: string, userId: string) {
    await this.findOne(workspaceId, itemId);

    const [updated] = await this.db
      .update(mediaItems)
      .set({
        isDeleted: true,
        deletedAt: new Date(),
        deletedById: userId,
        updatedAt: new Date(),
      })
      .where(eq(mediaItems.id, itemId))
      .returning();

    this.logger.log(`Soft deleted media item ${itemId}`);

    return updated;
  }

  /**
   * Restore a media item from recycle bin
   */
  async restore(workspaceId: string, itemId: string) {
    const [item] = await this.db
      .select()
      .from(mediaItems)
      .where(
        and(
          eq(mediaItems.id, itemId),
          eq(mediaItems.workspaceId, workspaceId),
          eq(mediaItems.isDeleted, true),
        ),
      )
      .limit(1);

    if (!item) {
      throw new NotFoundException('Item not found in recycle bin');
    }

    const [updated] = await this.db
      .update(mediaItems)
      .set({
        isDeleted: false,
        deletedAt: null,
        deletedById: null,
        updatedAt: new Date(),
      })
      .where(eq(mediaItems.id, itemId))
      .returning();

    this.logger.log(`Restored media item ${itemId}`);

    return updated;
  }

  /**
   * Permanently delete a media item. The row stays when storage refuses, so
   * the user can retry instead of leaving an orphaned file behind.
   */
  async permanentDelete(workspaceId: string, itemId: string) {
    const item = await this.findOne(workspaceId, itemId);

    const { failedIds } = await this.purgeItems([item]);
    if (failedIds.length > 0) {
      throw new BadGatewayException(
        'Could not delete the file from storage. Try again.',
      );
    }

    this.logger.log(`Permanently deleted media item ${itemId}`);

    return { success: true, message: 'Media item permanently deleted' };
  }

  /**
   * Deletes the files behind `rows` (at most PURGE_CONCURRENCY at a time) and
   * then only the rows whose file is gone. A file another row outside this set
   * still points at, or that a post or campaign slot still uses (SEC4), is
   * left in storage; its row is removed all the same.
   */
  async purgeItems(
    rows: MediaLibraryItem[],
  ): Promise<{ deletedIds: string[]; failedIds: string[] }> {
    const setIds = rows.map((r) => r.id);

    // Rows inside the set that share a file URL or a public id delete it once.
    const groupOf = new Map<string, MediaLibraryItem[]>();
    const groups = new Set<MediaLibraryItem[]>();
    for (const row of rows) {
      const keys = [`u:${row.fileUrl}`];
      if (row.cloudinaryPublicId) keys.push(`p:${row.cloudinaryPublicId}`);
      const known = keys
        .map((k) => groupOf.get(k))
        .filter((g): g is MediaLibraryItem[] => !!g);
      let group = known[0];
      if (!group) {
        group = [];
        groups.add(group);
      }
      // Merge any other group this row bridges into the first one.
      for (const other of known.slice(1)) {
        if (other !== group) {
          group.push(...other);
          groups.delete(other);
          for (const moved of other) {
            groupOf.set(`u:${moved.fileUrl}`, group);
            if (moved.cloudinaryPublicId) {
              groupOf.set(`p:${moved.cloudinaryPublicId}`, group);
            }
          }
        }
      }
      group.push(row);
      for (const k of keys) groupOf.set(k, group);
    }

    // One query each for the whole page, not one per file.
    const shared = await this.storageObjects.findSharedFiles(
      rows,
      setIds,
      this.db,
    );
    const referenced = await this.storageObjects.findReferencedItems(
      setIds,
      this.db,
    );

    const deletedIds: string[] = [];
    const failedIds: string[] = [];
    const queue = [...groups];

    const worker = async () => {
      for (let group = queue.shift(); group; group = queue.shift()) {
        try {
          // Another row shares the file, or a post / campaign slot uses it.
          const isFileInUse = group.some(
            (r) =>
              referenced.has(r.id) ||
              shared.urls.has(r.fileUrl) ||
              (!!r.cloudinaryPublicId &&
                shared.publicIds.has(r.cloudinaryPublicId)),
          );
          // TOCTOU: a row created between the share check and this delete can
          // still lose its file; accepted, the window is a few milliseconds.
          if (!isFileInUse) {
            const distinctUrls = new Map(
              group.map((r) => [
                r.cloudinaryPublicId
                  ? `p:${r.cloudinaryPublicId}`
                  : `u:${r.fileUrl}`,
                r,
              ]),
            );
            for (const ref of distinctUrls.values()) {
              await this.storageObjects.deleteFile(ref);
            }
          }
          deletedIds.push(...group.map((r) => r.id));
        } catch (error) {
          for (const row of group) {
            failedIds.push(row.id);
            this.logger.warn(
              `Failed to delete file for media item ${row.id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PURGE_CONCURRENCY, queue.length) }, worker),
    );

    for (let i = 0; i < deletedIds.length; i += DELETE_CHUNK) {
      await this.db
        .delete(mediaItems)
        .where(inArray(mediaItems.id, deletedIds.slice(i, i + DELETE_CHUNK)));
    }

    return { deletedIds, failedIds };
  }

  /**
   * Purges every deleted item in scope, a page at a time by id. The cursor
   * always moves past the page, so a row whose file will not delete cannot
   * stall the loop.
   */
  async purgeDeleted(scope: {
    workspaceId?: string;
    deletedBefore?: Date;
  }): Promise<{ deleted: number; failed: number }> {
    const base: SQL[] = [eq(mediaItems.isDeleted, true)];
    if (scope.workspaceId) {
      base.push(eq(mediaItems.workspaceId, scope.workspaceId));
    }
    if (scope.deletedBefore) {
      base.push(lt(mediaItems.deletedAt, scope.deletedBefore));
    }

    let deleted = 0;
    let failed = 0;
    let cursor: string | undefined;

    for (;;) {
      const page = await this.db
        .select()
        .from(mediaItems)
        .where(and(...base, cursor ? gt(mediaItems.id, cursor) : undefined))
        .orderBy(asc(mediaItems.id))
        .limit(PURGE_BATCH);
      if (page.length === 0) break;

      const result = await this.purgeItems(page);
      deleted += result.deletedIds.length;
      failed += result.failedIds.length;
      cursor = page[page.length - 1].id;
    }

    return { deleted, failed };
  }

  /**
   * Bulk actions on media items: on `ids`, or with `selectAll` on every item
   * the list's filter matches (ignoring `limit`/`offset`). Rows are written
   * 500 at a time.
   *
   * The action picks bin or live rows (`bulkTargetsBin`): restore and
   * permanentDelete touch only binned rows and refuse select-all; the rest
   * touch only live rows, whatever the filter's `isDeleted` says.
   * `affectedCount` counts only rows actually changed. The route requires
   * `posts:publish` for permanentDelete.
   *
   * Chunks are separate statements, not one transaction: a failure midway
   * leaves earlier chunks applied. Every action is idempotent, so retrying
   * the same request converges.
   */
  async bulkAction(
    workspaceId: string,
    userId: string,
    dto: BulkActionDto,
  ): Promise<{ affectedCount: number }> {
    assertIdsXorSelectAll(dto);
    const inBin = bulkTargetsBin(dto);
    const { action, categoryId } = dto;

    if (action === 'move') {
      // `undefined` means the caller never said where to move things, which
      // is not a move at all. `null` is a decision — unfile the selection —
      // so the two are told apart here rather than lumped as falsy.
      if (categoryId === undefined) {
        throw new BadRequestException('categoryId required for move action');
      }
      if (categoryId !== null) {
        await this.assertMediaFolder(workspaceId, categoryId);
      }
    }

    const ids = await this.resolveBulkIds(workspaceId, dto);

    let affectedCount = 0;
    for (const part of chunk(ids)) {
      affectedCount += await this.bulkChunk(
        workspaceId,
        userId,
        dto,
        part,
        inBin,
      );
    }

    this.logger.log(
      `Bulk ${action} on ${ids.length} media items in workspace ${workspaceId}`,
    );

    return { affectedCount };
  }

  /**
   * The ids a bulk request names. Explicit ids must all belong to the
   * workspace (else 400); select-all reads them through the list's filter,
   * on live rows only (a select-all bin action never gets this far).
   */
  private async resolveBulkIds(
    workspaceId: string,
    dto: BulkActionDto,
  ): Promise<string[]> {
    if (dto.selectAll != null) {
      const filter = { ...dto.selectAll.filter, isDeleted: false };
      const rows = await this.db
        .select({ id: mediaItems.id })
        .from(mediaItems)
        .where(and(...this.buildItemConditions(workspaceId, filter)))
        .orderBy(asc(mediaItems.id));
      return rows.map((r) => r.id);
    }

    const ids = dto.ids ?? [];
    if (ids.length === 0) return [];
    const found = await this.db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(
        and(
          inArray(mediaItems.id, ids),
          eq(mediaItems.workspaceId, workspaceId),
        ),
      );
    if (found.length !== ids.length) {
      throw new BadRequestException('Some items not found');
    }
    return ids;
  }

  /**
   * Runs one bulk action on one chunk of ids; returns the rows touched.
   * Only rows in the state the action works on (`inBin`) are touched.
   */
  private async bulkChunk(
    workspaceId: string,
    userId: string,
    dto: BulkActionDto,
    ids: string[],
    inBin: boolean,
  ): Promise<number> {
    const inScope = and(
      inArray(mediaItems.id, ids),
      eq(mediaItems.workspaceId, workspaceId),
      eq(mediaItems.isDeleted, inBin),
    );
    const now = new Date();

    const write = async (set: Partial<typeof mediaItems.$inferInsert>) =>
      (
        await this.db
          .update(mediaItems)
          .set({ ...set, updatedAt: now })
          .where(inScope)
          .returning({ id: mediaItems.id })
      ).length;

    switch (dto.action) {
      case 'delete':
        return write({ isDeleted: true, deletedAt: now, deletedById: userId });
      case 'restore':
        return write({ isDeleted: false, deletedAt: null, deletedById: null });
      case 'move':
        return write({ categoryId: dto.categoryId ?? null });
      case 'star':
        return write({ isStarred: true });
      case 'unstar':
        return write({ isStarred: false });
      case 'permanentDelete': {
        const rows = await this.db.select().from(mediaItems).where(inScope);
        const { deletedIds } = await this.purgeItems(rows);
        return deletedIds.length;
      }
    }
  }

  /**
   * Record that an item was just used: sets `lastUsedAt` (the "Recently used"
   * sort) and nothing else. `usage_count` is a post count kept by the posts
   * trigger (migration 0055), so a click here must not bump it (D13).
   *
   * Scoped to the workspace like every other write here: the id alone comes
   * from the client, so without the workspace in the WHERE clause any
   * authenticated user could touch someone else's asset.
   */
  async markUsed(workspaceId: string, itemId: string) {
    const [updated] = await this.db
      .update(mediaItems)
      .set({
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(eq(mediaItems.id, itemId), eq(mediaItems.workspaceId, workspaceId)),
      )
      .returning();

    if (!updated) {
      throw new NotFoundException('Media item not found');
    }

    return updated;
  }

  /**
   * Get items in recycle bin
   */
  async getRecycleBin(
    workspaceId: string,
    limit = 50,
    offset = 0,
    type?: 'image' | 'video' | 'gif' | 'document',
  ) {
    // The type filter lives in SQL: filtering a fetched page would return a
    // short page and a total that ignores the filter.
    const where = and(
      eq(mediaItems.workspaceId, workspaceId),
      eq(mediaItems.isDeleted, true),
      type ? eq(mediaItems.type, type) : undefined,
    );

    const items = await this.db
      .select()
      .from(mediaItems)
      .where(where)
      .orderBy(desc(mediaItems.deletedAt), desc(mediaItems.id))
      .limit(limit)
      .offset(offset);

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(mediaItems)
      .where(where);

    return {
      items,
      total: count,
      limit,
      offset,
    };
  }

  /**
   * Permanently delete items that have been in the recycle bin for over 30
   * days. Called by the scheduled job.
   */
  async cleanupRecycleBin(now: Date = new Date()) {
    const deletedBefore = new Date(
      now.getTime() - BIN_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const { deleted } = await this.purgeDeleted({ deletedBefore });

    this.logger.log(
      `Cleaned up ${deleted} items from recycle bin (older than ${BIN_RETENTION_DAYS} days)`,
    );

    return { deletedCount: deleted };
  }
}
