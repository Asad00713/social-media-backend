import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { eq, and, desc, asc, like, or, isNull, sql, inArray } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import {
  mediaItems,
  mediaCategories,
  NewMediaItem,
} from '../../drizzle/schema/media-library.schema';
import { CloudinaryService } from '../../media/cloudinary.service';
import {
  CreateMediaItemDto,
  UpdateMediaItemDto,
  MediaItemQueryDto,
  BulkActionDto,
} from '../dto/media-library.dto';

@Injectable()
export class MediaItemService {
  private readonly logger = new Logger(MediaItemService.name);

  constructor(private readonly cloudinaryService: CloudinaryService) {}

  /**
   * Create a new media item
   */
  async create(
    workspaceId: string,
    userId: string,
    dto: CreateMediaItemDto,
  ) {
    // Validate category if provided
    if (dto.categoryId) {
      const category = await db
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

      // Ensure category type matches item type
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

    const [created] = await db
      .insert(mediaItems)
      .values(newItem)
      .returning();

    this.logger.log(`Created media item "${dto.name}" for workspace ${workspaceId}`);

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
      conditions.push(
        or(
          like(mediaItems.name, `%${search}%`),
          like(mediaItems.description, `%${search}%`),
        )!,
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

    const items = await db
      .select({
        item: mediaItems,
        category: mediaCategories,
      })
      .from(mediaItems)
      .leftJoin(mediaCategories, eq(mediaItems.categoryId, mediaCategories.id))
      .where(and(...conditions))
      .orderBy(orderFn(sortColumn))
      .limit(limit)
      .offset(offset);

    // Get total count
    const [{ count }] = await db
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
    const items = await db
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
    const [item] = await db
      .select({
        item: mediaItems,
        category: mediaCategories,
      })
      .from(mediaItems)
      .leftJoin(mediaCategories, eq(mediaItems.categoryId, mediaCategories.id))
      .where(
        and(
          eq(mediaItems.id, itemId),
          eq(mediaItems.workspaceId, workspaceId),
        ),
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
  async update(
    workspaceId: string,
    itemId: string,
    dto: UpdateMediaItemDto,
  ) {
    const existing = await this.findOne(workspaceId, itemId);

    // Validate category if changing
    if (dto.categoryId && dto.categoryId !== existing.categoryId) {
      const category = await db
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

    const [updated] = await db
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

    const [updated] = await db
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
    const [item] = await db
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

    const [updated] = await db
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
   * Permanently delete a media item
   */
  async permanentDelete(workspaceId: string, itemId: string) {
    const item = await this.findOne(workspaceId, itemId);

    // Delete from Cloudinary if we have the public ID
    if (item.cloudinaryPublicId) {
      try {
        const resourceType = item.type === 'video' ? 'video' : 'image';
        await this.cloudinaryService.delete(
          item.cloudinaryPublicId,
          resourceType,
        );
        this.logger.log(
          `Deleted from Cloudinary: ${item.cloudinaryPublicId}`,
        );
      } catch (error) {
        this.logger.warn(
          `Failed to delete from Cloudinary: ${item.cloudinaryPublicId}`,
          error,
        );
      }
    }

    await db.delete(mediaItems).where(eq(mediaItems.id, itemId));

    this.logger.log(`Permanently deleted media item ${itemId}`);

    return { success: true, message: 'Media item permanently deleted' };
  }

  /**
   * Bulk actions on media items
   */
  async bulkAction(
    workspaceId: string,
    userId: string,
    dto: BulkActionDto,
  ) {
    const { ids, action, categoryId } = dto;

    // Verify all items belong to this workspace
    const items = await db
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

    switch (action) {
      case 'delete':
        await db
          .update(mediaItems)
          .set({
            isDeleted: true,
            deletedAt: new Date(),
            deletedById: userId,
            updatedAt: new Date(),
          })
          .where(inArray(mediaItems.id, ids));
        break;

      case 'restore':
        await db
          .update(mediaItems)
          .set({
            isDeleted: false,
            deletedAt: null,
            deletedById: null,
            updatedAt: new Date(),
          })
          .where(inArray(mediaItems.id, ids));
        break;

      case 'move':
        if (!categoryId) {
          throw new BadRequestException('categoryId required for move action');
        }
        await db
          .update(mediaItems)
          .set({ categoryId, updatedAt: new Date() })
          .where(inArray(mediaItems.id, ids));
        break;

      case 'star':
        await db
          .update(mediaItems)
          .set({ isStarred: true, updatedAt: new Date() })
          .where(inArray(mediaItems.id, ids));
        break;

      case 'unstar':
        await db
          .update(mediaItems)
          .set({ isStarred: false, updatedAt: new Date() })
          .where(inArray(mediaItems.id, ids));
        break;

      case 'permanentDelete':
        // Delete from Cloudinary
        for (const item of items) {
          if (item.cloudinaryPublicId) {
            try {
              const resourceType = item.type === 'video' ? 'video' : 'image';
              await this.cloudinaryService.delete(
                item.cloudinaryPublicId,
                resourceType,
              );
            } catch (error) {
              this.logger.warn(
                `Failed to delete from Cloudinary: ${item.cloudinaryPublicId}`,
              );
            }
          }
        }
        await db.delete(mediaItems).where(inArray(mediaItems.id, ids));
        break;
    }

    this.logger.log(
      `Bulk ${action} on ${ids.length} media items in workspace ${workspaceId}`,
    );

    return {
      success: true,
      message: `${action} completed on ${ids.length} items`,
      affectedCount: ids.length,
    };
  }

  /**
   * Increment usage count when item is used in a post
   */
  async incrementUsage(itemId: string) {
    await db
      .update(mediaItems)
      .set({
        usageCount: sql`${mediaItems.usageCount} + 1`,
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(mediaItems.id, itemId));
  }

  /**
   * Get items in recycle bin
   */
  async getRecycleBin(workspaceId: string, limit = 50, offset = 0) {
    const items = await db
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

    const [{ count }] = await db
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
   * Permanently delete items older than 30 days in recycle bin
   * This should be called by a scheduled job
   */
  async cleanupRecycleBin() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const itemsToDelete = await db
      .select()
      .from(mediaItems)
      .where(
        and(
          eq(mediaItems.isDeleted, true),
          sql`${mediaItems.deletedAt} < ${thirtyDaysAgo}`,
        ),
      );

    // Delete from Cloudinary
    for (const item of itemsToDelete) {
      if (item.cloudinaryPublicId) {
        try {
          const resourceType = item.type === 'video' ? 'video' : 'image';
          await this.cloudinaryService.delete(
            item.cloudinaryPublicId,
            resourceType,
          );
        } catch (error) {
          this.logger.warn(
            `Failed to delete from Cloudinary: ${item.cloudinaryPublicId}`,
          );
        }
      }
    }

    // Delete from database
    const result = await db
      .delete(mediaItems)
      .where(
        and(
          eq(mediaItems.isDeleted, true),
          sql`${mediaItems.deletedAt} < ${thirtyDaysAgo}`,
        ),
      )
      .returning();

    this.logger.log(
      `Cleaned up ${result.length} items from recycle bin (older than 30 days)`,
    );

    return {
      deletedCount: result.length,
    };
  }
}
