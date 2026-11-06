import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { eq, and, desc, asc, ilike, sql, type SQL } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import {
  mediaCategories,
  NewMediaCategory,
  type MediaCategory,
} from '../../drizzle/schema/media-library.schema';
import { users } from '../../drizzle/schema/users.schema';
import type { FolderKind } from '../lib/folder-kind';
import { toUserRef, USER_REF_COLUMNS, type UserRefRow } from '../lib/user-ref';
import { ilikePattern } from '../lib/search';
import {
  CreateCategoryDto,
  UpdateCategoryDto,
  CategoryQueryDto,
} from '../dto/media-library.dto';
import type { FolderCreator, FolderStats } from '../dto/contract';

/**
 * A folder as every folder route returns it: its columns, its creator (null
 * for folders made before migration 0056) and, with `withStats`, its stats.
 */
export type CategoryView = MediaCategory & Pick<FolderCreator, 'createdBy'>;
export type CategoryWithStats = CategoryView & { stats?: FolderStats };

const c = mediaCategories;

/** The columns a `CategoryView` is read from; creator left-joined. */
const VIEW_SELECTION = {
  folder: mediaCategories,
  creator: USER_REF_COLUMNS,
};

function toCategoryView(row: {
  folder: MediaCategory;
  creator: UserRefRow | null;
}): CategoryView {
  return { ...row.folder, createdBy: toUserRef(row.creator) };
}

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
   * Create a new category, recorded as made by `userId`.
   */
  async create(
    workspaceId: string,
    userId: string,
    dto: CreateCategoryDto,
  ): Promise<CategoryView> {
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
      createdById: userId,
    };

    const [created] = await this.db
      .insert(mediaCategories)
      .values(newCategory)
      .returning({ id: mediaCategories.id });

    this.logger.log(
      `Created category "${dto.name}" for workspace ${workspaceId}`,
    );

    return this.findOne(workspaceId, created.id);
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

    // The creator join is on a primary key: one row per folder either way.
    if (!query.withStats) {
      const rows = await this.db
        .select(VIEW_SELECTION)
        .from(mediaCategories)
        .leftJoin(users, eq(mediaCategories.createdById, users.id))
        .where(and(...conditions))
        .orderBy(...order);
      return rows.map(toCategoryView);
    }

    const rows = await this.db
      .select({
        ...VIEW_SELECTION,
        statsItemCount: sql<number>`(media_stats.item_count + template_stats.item_count + link_stats.item_count + snippet_stats.item_count)`,
        statsBytes: sql<number>`media_stats.bytes`,
        statsCovers: sql<
          string[]
        >`COALESCE(media_stats.covers, template_stats.covers, link_stats.covers, '{}'::text[])`,
      })
      .from(mediaCategories)
      .leftJoin(users, eq(mediaCategories.createdById, users.id))
      .leftJoinLateral(MEDIA_STATS, sql`true`)
      .leftJoinLateral(TEMPLATE_STATS, sql`true`)
      .leftJoinLateral(LINK_STATS, sql`true`)
      .leftJoinLateral(SNIPPET_STATS, sql`true`)
      .where(and(...conditions))
      .orderBy(...order);

    return rows.map(
      ({ statsItemCount, statsBytes, statsCovers, ...category }) => ({
        ...toCategoryView(category),
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
  async findOne(
    workspaceId: string,
    categoryId: string,
  ): Promise<CategoryView> {
    return this.readView(
      and(
        eq(mediaCategories.id, categoryId),
        eq(mediaCategories.workspaceId, workspaceId),
      ),
    );
  }

  /** The one read behind every single-folder `CategoryView`. */
  private async readView(where: SQL | undefined): Promise<CategoryView> {
    const [category] = await this.db
      .select(VIEW_SELECTION)
      .from(mediaCategories)
      .leftJoin(users, eq(mediaCategories.createdById, users.id))
      .where(where)
      .limit(1);

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    return toCategoryView(category);
  }

  /**
   * Update a category
   */
  async update(
    workspaceId: string,
    categoryId: string,
    dto: UpdateCategoryDto,
  ): Promise<CategoryView> {
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

    await this.db
      .update(mediaCategories)
      .set(updateData)
      .where(
        and(
          eq(mediaCategories.id, categoryId),
          eq(mediaCategories.workspaceId, workspaceId),
        ),
      );

    this.logger.log(`Updated category ${categoryId}`);

    return this.findOne(workspaceId, categoryId);
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
