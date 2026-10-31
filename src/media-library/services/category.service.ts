import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { eq, and, desc, asc, ilike, sql, getTableColumns } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import {
  mediaCategories,
  NewMediaCategory,
  type MediaCategory,
} from '../../drizzle/schema/media-library.schema';
import type { FolderKind } from '../lib/folder-kind';
import { ilikePattern } from '../lib/search';
import {
  CreateCategoryDto,
  UpdateCategoryDto,
  CategoryQueryDto,
} from '../dto/media-library.dto';
import type { FolderStats } from '../dto/contract';

export type CategoryWithStats = MediaCategory & { stats?: FolderStats };

const c = mediaCategories;

// One LATERAL aggregate per folder kind. Each is guarded by the folder's own
// kind, so for any folder only its matching aggregate scans rows; the other
// three return count 0 and NULL covers. Live rows only (not in the bin).
const MEDIA_COVER = sql.raw(
  `COALESCE(i.thumbnail_url, CASE WHEN i.type IN ('image', 'gif') THEN i.file_url END)`,
);
const MEDIA_STATS = sql`(
  SELECT count(*)::int AS item_count,
         COALESCE(sum(i.file_size), 0)::float8 AS bytes,
         (array_agg(${MEDIA_COVER} ORDER BY i.created_at DESC, i.id DESC)
            FILTER (WHERE ${MEDIA_COVER} IS NOT NULL))[1:4] AS covers
    FROM media_items i
   WHERE ${c.type} = 'media'
     AND i.category_id = ${c.id}
     AND i.workspace_id = ${c.workspaceId}
     AND i.is_deleted = false
) AS media_stats`;
const TEMPLATE_STATS = sql`(
  SELECT count(*)::int AS item_count,
         (array_agg(t.thumbnail_url ORDER BY t.created_at DESC, t.id DESC)
            FILTER (WHERE t.thumbnail_url IS NOT NULL))[1:4] AS covers
    FROM media_templates t
   WHERE ${c.type} = 'template'
     AND t.category_id = ${c.id}
     AND t.workspace_id = ${c.workspaceId}
     AND t.is_deleted = false
) AS template_stats`;
const LINK_STATS = sql`(
  SELECT count(*)::int AS item_count,
         (array_agg(l.preview_image_url ORDER BY l.created_at DESC, l.id DESC)
            FILTER (WHERE l.preview_image_url IS NOT NULL))[1:4] AS covers
    FROM saved_links l
   WHERE ${c.type} = 'link'
     AND l.category_id = ${c.id}
     AND l.workspace_id = ${c.workspaceId}
     AND l.is_deleted = false
) AS link_stats`;
const SNIPPET_STATS = sql`(
  SELECT count(*)::int AS item_count
    FROM text_snippets s
   WHERE ${c.type} = 'text_snippet'
     AND s.category_id = ${c.id}
     AND s.workspace_id = ${c.workspaceId}
     AND s.is_deleted = false
) AS snippet_stats`;

@Injectable()
export class CategoryService {
  private readonly logger = new Logger(CategoryService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /**
   * Create a new category
   */
  async create(workspaceId: string, dto: CreateCategoryDto) {
    // A folder belongs to one type, so a name is unique per (workspace, type):
    // the same name may exist as an image folder and a video folder.
    const existing = await this.db
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
        `A ${dto.type} folder named "${dto.name}" already exists`,
      );
    }

    // Get max display order within this workspace + type
    const maxOrder = await this.db
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

    const [created] = await this.db
      .insert(mediaCategories)
      .values(newCategory)
      .returning();

    this.logger.log(
      `Created category "${dto.name}" for workspace ${workspaceId}`,
    );

    return created;
  }

  /**
   * Get all categories for a workspace. `search` matches the name;
   * `withStats` adds each folder's live item count, bytes and covers in the
   * same single statement.
   */
  async findAll(
    workspaceId: string,
    query: CategoryQueryDto = {},
  ): Promise<CategoryWithStats[]> {
    const conditions = [eq(mediaCategories.workspaceId, workspaceId)];

    if (query.type) {
      conditions.push(eq(mediaCategories.type, query.type));
    }
    if (query.search) {
      conditions.push(ilike(mediaCategories.name, ilikePattern(query.search)));
    }
    const order = [
      asc(mediaCategories.displayOrder),
      asc(mediaCategories.name),
    ];

    if (!query.withStats) {
      return this.db
        .select()
        .from(mediaCategories)
        .where(and(...conditions))
        .orderBy(...order);
    }

    const rows = await this.db
      .select({
        ...getTableColumns(mediaCategories),
        statsItemCount: sql<number>`(media_stats.item_count + template_stats.item_count + link_stats.item_count + snippet_stats.item_count)`,
        statsBytes: sql<number>`media_stats.bytes`,
        statsCovers: sql<
          string[]
        >`COALESCE(media_stats.covers, template_stats.covers, link_stats.covers, '{}'::text[])`,
      })
      .from(mediaCategories)
      .leftJoinLateral(MEDIA_STATS, sql`true`)
      .leftJoinLateral(TEMPLATE_STATS, sql`true`)
      .leftJoinLateral(LINK_STATS, sql`true`)
      .leftJoinLateral(SNIPPET_STATS, sql`true`)
      .where(and(...conditions))
      .orderBy(...order);

    return rows.map(
      ({ statsItemCount, statsBytes, statsCovers, ...category }) => ({
        ...category,
        stats: {
          itemCount: statsItemCount,
          bytes: statsBytes,
          covers: statsCovers,
        },
      }),
    );
  }

  /**
   * Get categories grouped by type
   */
  async findAllGroupedByType(workspaceId: string) {
    const categories = await this.findAll(workspaceId);

    const grouped: Record<FolderKind, CategoryWithStats[]> = {
      media: [],
      template: [],
      text_snippet: [],
      link: [],
    };

    for (const category of categories) {
      const type = category.type;
      if (type && grouped[type]) {
        grouped[type].push(category);
      }
    }

    return grouped;
  }

  /**
   * Get a single category by ID
   */
  async findOne(workspaceId: string, categoryId: string) {
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

    // Items filed in this folder belong to its tab; a new kind would strand
    // them in the wrong one.
    if (dto.type !== undefined && dto.type !== existing.type) {
      throw new BadRequestException("A folder's kind cannot change");
    }

    // Check for duplicate name if name is being changed (unique per
    // workspace + type — the folder's type can't change on update).
    if (dto.name && dto.name !== existing.name) {
      const duplicate = await this.db
        .select()
        .from(mediaCategories)
        .where(
          and(
            eq(mediaCategories.workspaceId, workspaceId),
            eq(mediaCategories.type, existing.type),
            eq(mediaCategories.name, dto.name),
          ),
        )
        .limit(1);

      if (duplicate.length > 0) {
        throw new ConflictException(
          `A ${existing.type} folder named "${dto.name}" already exists`,
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
    if (dto.displayOrder !== undefined)
      updateData.displayOrder = dto.displayOrder;

    const [updated] = await this.db
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

    await this.db
      .delete(mediaCategories)
      .where(eq(mediaCategories.id, categoryId));

    this.logger.log(`Deleted category ${categoryId}`);

    return { success: true, message: 'Category deleted successfully' };
  }

  /**
   * Reorder categories within a type
   */
  async reorder(workspaceId: string, type: FolderKind, categoryIds: string[]) {
    // Verify all categories exist and belong to this workspace/type
    const categories = await this.db
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
      this.db
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
