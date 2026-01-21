import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { eq, and, desc, asc } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import {
  mediaCategories,
  MediaLibraryType,
  NewMediaCategory,
} from '../../drizzle/schema/media-library.schema';
import {
  CreateCategoryDto,
  UpdateCategoryDto,
  CategoryQueryDto,
} from '../dto/media-library.dto';

@Injectable()
export class CategoryService {
  private readonly logger = new Logger(CategoryService.name);

  /**
   * Create a new category
   */
  async create(
    workspaceId: string,
    dto: CreateCategoryDto,
  ) {
    // Check for duplicate name within same type
    const existing = await db
      .select()
      .from(mediaCategories)
      .where(
        and(
          eq(mediaCategories.workspaceId, workspaceId),
          eq(mediaCategories.type, dto.type),
          eq(mediaCategories.name, dto.name),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      throw new ConflictException(
        `Category "${dto.name}" already exists for type "${dto.type}"`,
      );
    }

    // Get max display order
    const maxOrder = await db
      .select({ maxOrder: mediaCategories.displayOrder })
      .from(mediaCategories)
      .where(
        and(
          eq(mediaCategories.workspaceId, workspaceId),
          eq(mediaCategories.type, dto.type),
        ),
      )
      .orderBy(desc(mediaCategories.displayOrder))
      .limit(1);

    const displayOrder = (maxOrder[0]?.maxOrder ?? -1) + 1;

    const newCategory: NewMediaCategory = {
      workspaceId,
      name: dto.name,
      description: dto.description,
      type: dto.type,
      color: dto.color,
      icon: dto.icon,
      displayOrder,
    };

    const [created] = await db
      .insert(mediaCategories)
      .values(newCategory)
      .returning();

    this.logger.log(
      `Created category "${dto.name}" for workspace ${workspaceId}`,
    );

    return created;
  }

  /**
   * Get all categories for a workspace
   */
  async findAll(workspaceId: string, query: CategoryQueryDto = {}) {
    const conditions = [eq(mediaCategories.workspaceId, workspaceId)];

    if (query.type) {
      conditions.push(eq(mediaCategories.type, query.type));
    }

    const categories = await db
      .select()
      .from(mediaCategories)
      .where(and(...conditions))
      .orderBy(asc(mediaCategories.type), asc(mediaCategories.displayOrder));

    return categories;
  }

  /**
   * Get categories grouped by type
   */
  async findAllGroupedByType(workspaceId: string) {
    const categories = await this.findAll(workspaceId);

    const grouped: Record<MediaLibraryType, typeof categories> = {
      image: [],
      video: [],
      gif: [],
      template: [],
      document: [],
      text_snippet: [],
      link: [],
    };

    for (const category of categories) {
      const type = category.type as MediaLibraryType;
      if (grouped[type]) {
        grouped[type].push(category);
      }
    }

    return grouped;
  }

  /**
   * Get a single category by ID
   */
  async findOne(workspaceId: string, categoryId: string) {
    const [category] = await db
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
      throw new NotFoundException('Category not found');
    }

    return category;
  }

  /**
   * Update a category
   */
  async update(
    workspaceId: string,
    categoryId: string,
    dto: UpdateCategoryDto,
  ) {
    const existing = await this.findOne(workspaceId, categoryId);

    // Check for duplicate name if name is being changed
    if (dto.name && dto.name !== existing.name) {
      const duplicate = await db
        .select()
        .from(mediaCategories)
        .where(
          and(
            eq(mediaCategories.workspaceId, workspaceId),
            eq(mediaCategories.type, existing.type as MediaLibraryType),
            eq(mediaCategories.name, dto.name),
          ),
        )
        .limit(1);

      if (duplicate.length > 0) {
        throw new ConflictException(
          `Category "${dto.name}" already exists for type "${existing.type}"`,
        );
      }
    }

    const updateData: Partial<typeof mediaCategories.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.color !== undefined) updateData.color = dto.color;
    if (dto.icon !== undefined) updateData.icon = dto.icon;
    if (dto.displayOrder !== undefined) updateData.displayOrder = dto.displayOrder;

    const [updated] = await db
      .update(mediaCategories)
      .set(updateData)
      .where(eq(mediaCategories.id, categoryId))
      .returning();

    this.logger.log(`Updated category ${categoryId}`);

    return updated;
  }

  /**
   * Delete a category
   * Items in this category will have their categoryId set to null
   */
  async delete(workspaceId: string, categoryId: string) {
    await this.findOne(workspaceId, categoryId);

    await db
      .delete(mediaCategories)
      .where(eq(mediaCategories.id, categoryId));

    this.logger.log(`Deleted category ${categoryId}`);

    return { success: true, message: 'Category deleted successfully' };
  }

  /**
   * Reorder categories within a type
   */
  async reorder(
    workspaceId: string,
    type: MediaLibraryType,
    categoryIds: string[],
  ) {
    // Verify all categories exist and belong to this workspace/type
    const categories = await db
      .select()
      .from(mediaCategories)
      .where(
        and(
          eq(mediaCategories.workspaceId, workspaceId),
          eq(mediaCategories.type, type),
        ),
      );

    const categoryMap = new Map(categories.map((c) => [c.id, c]));

    for (const id of categoryIds) {
      if (!categoryMap.has(id)) {
        throw new NotFoundException(`Category ${id} not found`);
      }
    }

    // Update display orders
    const updates = categoryIds.map((id, index) =>
      db
        .update(mediaCategories)
        .set({ displayOrder: index, updatedAt: new Date() })
        .where(eq(mediaCategories.id, id)),
    );

    await Promise.all(updates);

    this.logger.log(
      `Reordered ${categoryIds.length} categories for type ${type}`,
    );

    return { success: true, message: 'Categories reordered successfully' };
  }
}
