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
  isNull,
  sql,
  inArray,
  gt,
  lt,
  type SQL,
} from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import {
  mediaItems,
  mediaCategories,
  NewMediaItem,
  MediaLibraryItem,
} from '../../drizzle/schema/media-library.schema';
import { ilikePattern } from '../lib/search';
import { CloudinaryService } from '../../media/cloudinary.service';
import { StorageObjectService } from './storage-object.service';
import {
  CreateMediaItemDto,
  UpdateMediaItemDto,
  MediaItemQueryDto,
  BulkActionDto,
} from '../dto/media-library.dto';

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
   * Create a new media item
   */
  async create(workspaceId: string, userId: string, dto: CreateMediaItemDto) {
    // Validate category if provided
    if (dto.categoryId) {
      const category = await this.db
        .select()
        .from(mediaCategories)
        .where(
          and(
            eq(mediaCategories.id, dto.categoryId),
            eq(mediaCategories.workspaceId, workspaceId),
          ),
        )
        .limit(1);

      if (category.length === 0) {
        throw new BadRequestException('Category not found');
      }

      // A folder belongs to one type — an item can only be filed into a folder
      // of its own type (an image can't live in a video folder).
      if (category[0].type !== dto.type) {
        throw new BadRequestException(
          `Category type "${category[0].type}" does not match item type "${dto.type}"`,
        );
      }
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
      categoryId: dto.categoryId,
      tags: dto.tags || [],
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
   * Get all media items for a workspace with filtering
   */
  async findAll(workspaceId: string, query: MediaItemQueryDto = {}) {
    const {
      type,
      categoryId,
      isStarred,
      isDeleted = false,
      search,
      tags,
      limit = 50,
      offset = 0,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = query;

    const conditions = [
      eq(mediaItems.workspaceId, workspaceId),
      eq(mediaItems.isDeleted, isDeleted),
    ];

    if (type) {
      conditions.push(eq(mediaItems.type, type));
    }

    if (categoryId) {
      conditions.push(eq(mediaItems.categoryId, categoryId));
    }

    if (isStarred !== undefined) {
      conditions.push(eq(mediaItems.isStarred, isStarred));
    }

    if (search) {
      conditions.push(ilike(mediaItems.name, ilikePattern(search)));
    }

    if (tags && tags.length > 0) {
      conditions.push(
        sql`${mediaItems.tags} @> ${JSON.stringify(tags)}::jsonb`,
      );
    }

    // Get sort column
    const sortColumn = {
      createdAt: mediaItems.createdAt,
      name: mediaItems.name,
      usageCount: mediaItems.usageCount,
      lastUsedAt: mediaItems.lastUsedAt,
    }[sortBy];

    const orderFn = sortOrder === 'asc' ? asc : desc;

    // `lastUsedAt` stays null until an asset is used in a post, so "never used"
    // belongs after everything that has been used. Postgres puts NULLS FIRST
    // for DESC by default, which ranked untouched assets above used ones.
    const primaryOrder =
      sortBy === 'lastUsedAt'
        ? sortOrder === 'asc'
          ? sql`${mediaItems.lastUsedAt} ASC NULLS LAST`
          : sql`${mediaItems.lastUsedAt} DESC NULLS LAST`
        : orderFn(sortColumn);

    // Ties need a deterministic tiebreaker. With every row sharing a null
    // `lastUsedAt`, ordering on that column alone left Postgres free to return
    // rows in heap order — and an UPDATE (starring an asset) rewrites the tuple
    // at the end of the heap, so starring an image visibly threw it to the
    // bottom of the grid. Stable secondary keys keep positions still.
    const items = await this.db
      .select({
        item: mediaItems,
        category: mediaCategories,
      })
      .from(mediaItems)
      .leftJoin(mediaCategories, eq(mediaItems.categoryId, mediaCategories.id))
      .where(and(...conditions))
      .orderBy(primaryOrder, desc(mediaItems.createdAt), desc(mediaItems.id))
      .limit(limit)
      .offset(offset);

    // Get total count
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(mediaItems)
      .where(and(...conditions));

    return {
      items: items.map((row) => ({
        ...row.item,
        category: row.category,
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
  async findOne(workspaceId: string, itemId: string) {
    const [item] = await this.db
      .select({
        item: mediaItems,
        category: mediaCategories,
      })
      .from(mediaItems)
      .leftJoin(mediaCategories, eq(mediaItems.categoryId, mediaCategories.id))
      .where(
        and(eq(mediaItems.id, itemId), eq(mediaItems.workspaceId, workspaceId)),
      )
      .limit(1);

    if (!item) {
      throw new NotFoundException('Media item not found');
    }

    return {
      ...item.item,
      category: item.category,
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
      const category = await this.db
        .select()
        .from(mediaCategories)
        .where(
          and(
            eq(mediaCategories.id, dto.categoryId),
            eq(mediaCategories.workspaceId, workspaceId),
          ),
        )
        .limit(1);

      if (category.length === 0) {
        throw new BadRequestException('Category not found');
      }

      if (category[0].type !== existing.type) {
        throw new BadRequestException(
          `Category type "${category[0].type}" does not match item type "${existing.type}"`,
        );
      }
    }

    const updateData: Partial<typeof mediaItems.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.categoryId !== undefined) updateData.categoryId = dto.categoryId;
    if (dto.tags !== undefined) updateData.tags = dto.tags;
    if (dto.isStarred !== undefined) updateData.isStarred = dto.isStarred;

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
   * still points at is left in storage; its row is removed all the same.
   */
  async purgeItems(
    rows: MediaLibraryItem[],
  ): Promise<{ deletedIds: string[]; failedIds: string[] }> {
    const setIds = rows.map((r) => r.id);

    // Rows inside the set that share one file delete it once.
    const groups = new Map<string, MediaLibraryItem[]>();
    for (const row of rows) {
      const group = groups.get(row.fileUrl);
      if (group) group.push(row);
      else groups.set(row.fileUrl, [row]);
    }

    const deletedIds: string[] = [];
    const failedIds: string[] = [];
    const queue = [...groups.values()];

    const worker = async () => {
      for (let group = queue.shift(); group; group = queue.shift()) {
        const first = group[0];
        try {
          const shared = await this.storageObjects.isFileShared(
            first,
            setIds,
            this.db,
          );
          if (!shared) await this.storageObjects.deleteFile(first);
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
   * Bulk actions on media items
   */
  async bulkAction(workspaceId: string, userId: string, dto: BulkActionDto) {
    const { ids, action, categoryId } = dto;

    // Verify all items belong to this workspace
    const items = await this.db
      .select()
      .from(mediaItems)
      .where(
        and(
          inArray(mediaItems.id, ids),
          eq(mediaItems.workspaceId, workspaceId),
        ),
      );

    if (items.length !== ids.length) {
      throw new BadRequestException('Some items not found');
    }

    let affectedCount = 0;

    switch (action) {
      case 'delete':
        affectedCount = (
          await this.db
            .update(mediaItems)
            .set({
              isDeleted: true,
              deletedAt: new Date(),
              deletedById: userId,
              updatedAt: new Date(),
            })
            .where(inArray(mediaItems.id, ids))
            .returning({ id: mediaItems.id })
        ).length;
        break;

      case 'restore':
        affectedCount = (
          await this.db
            .update(mediaItems)
            .set({
              isDeleted: false,
              deletedAt: null,
              deletedById: null,
              updatedAt: new Date(),
            })
            .where(inArray(mediaItems.id, ids))
            .returning({ id: mediaItems.id })
        ).length;
        break;

      case 'move': {
        // `undefined` means the caller never said where to move things, which
        // is not a move at all. `null` is a decision — unfile the selection —
        // so the two are told apart here rather than lumped as falsy.
        if (categoryId === undefined) {
          throw new BadRequestException('categoryId required for move action');
        }

        if (categoryId !== null) {
          const [category] = await this.db
            .select()
            .from(mediaCategories)
            .where(
              and(
                eq(mediaCategories.id, categoryId),
                eq(mediaCategories.workspaceId, workspaceId),
              ),
            )
            .limit(1);

          if (!category) {
            throw new BadRequestException('Category not found');
          }

          // Folders belong to exactly one type, and single-item moves already
          // enforce that. Without the same check here, a bulk move could file
          // a video into an Images folder — where it would then be invisible
          // to the Videos section that owns it.
          const mismatched = items.find((item) => item.type !== category.type);
          if (mismatched) {
            throw new BadRequestException(
              `Category type "${category.type}" does not match item type "${mismatched.type}"`,
            );
          }
        }

        affectedCount = (
          await this.db
            .update(mediaItems)
            .set({ categoryId, updatedAt: new Date() })
            .where(inArray(mediaItems.id, ids))
            .returning({ id: mediaItems.id })
        ).length;
        break;
      }

      case 'star':
        affectedCount = (
          await this.db
            .update(mediaItems)
            .set({ isStarred: true, updatedAt: new Date() })
            .where(inArray(mediaItems.id, ids))
            .returning({ id: mediaItems.id })
        ).length;
        break;

      case 'unstar':
        affectedCount = (
          await this.db
            .update(mediaItems)
            .set({ isStarred: false, updatedAt: new Date() })
            .where(inArray(mediaItems.id, ids))
            .returning({ id: mediaItems.id })
        ).length;
        break;

      case 'permanentDelete': {
        const { deletedIds } = await this.purgeItems(items);
        affectedCount = deletedIds.length;
        break;
      }
    }

    this.logger.log(
      `Bulk ${action} on ${ids.length} media items in workspace ${workspaceId}`,
    );

    return { affectedCount };
  }

  /**
   * Record that an item was used in a post.
   *
   * Scoped to the workspace like every other write here: the id alone comes
   * from the client, so without the workspace in the WHERE clause any
   * authenticated user could bump the counters on someone else's asset.
   *
   * This is what fills `lastUsedAt`, which the "Recently used" view and the
   * "Most used" sort both read — until something calls this, both are empty by
   * construction.
   */
  async incrementUsage(workspaceId: string, itemId: string) {
    const [updated] = await this.db
      .update(mediaItems)
      .set({
        usageCount: sql`${mediaItems.usageCount} + 1`,
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
  async getRecycleBin(workspaceId: string, limit = 50, offset = 0) {
    const items = await this.db
      .select()
      .from(mediaItems)
      .where(
        and(
          eq(mediaItems.workspaceId, workspaceId),
          eq(mediaItems.isDeleted, true),
        ),
      )
      .orderBy(desc(mediaItems.deletedAt))
      .limit(limit)
      .offset(offset);

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(mediaItems)
      .where(
        and(
          eq(mediaItems.workspaceId, workspaceId),
          eq(mediaItems.isDeleted, true),
        ),
      );

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
