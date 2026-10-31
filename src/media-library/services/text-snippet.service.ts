import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { eq, and, desc, ilike, or, sql, inArray, type SQL } from 'drizzle-orm';
import { ilikePattern } from '../lib/search';
import { assertIdsXorSelectAll, chunk } from '../lib/bulk';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import {
  textSnippets,
  mediaCategories,
  NewTextSnippet,
} from '../../drizzle/schema/media-library.schema';
import {
  CreateTextSnippetDto,
  UpdateTextSnippetDto,
  TextSnippetQueryDto,
  SnippetBulkDto,
} from '../dto/media-library.dto';

/**
 * ORDER BY for `GET snippets` (ruling 7). Every order ends in `id DESC` so
 * ties keep their place across updates.
 */
function snippetOrder(sort: TextSnippetQueryDto['sort']): SQL[] {
  const byNewest = [desc(textSnippets.createdAt), desc(textSnippets.id)];
  switch (sort) {
    case 'most_used':
      return [sql`${textSnippets.usageCount} DESC NULLS LAST`, ...byNewest];
    case 'recently_used':
      return [sql`${textSnippets.lastUsedAt} DESC NULLS LAST`, ...byNewest];
    case 'name':
      return [sql`lower(${textSnippets.name}) ASC`, ...byNewest];
    default:
      return byNewest;
  }
}

@Injectable()
export class TextSnippetService {
  private readonly logger = new Logger(TextSnippetService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /**
   * Create a new text snippet
   */
  async create(workspaceId: string, userId: string, dto: CreateTextSnippetDto) {
    // Validate category if provided
    if (dto.categoryId) {
      const category = await this.db
        .select()
        .from(mediaCategories)
        .where(
          and(
            eq(mediaCategories.id, dto.categoryId),
            eq(mediaCategories.workspaceId, workspaceId),
            eq(mediaCategories.type, 'text_snippet'),
          ),
        )
        .limit(1);

      if (category.length === 0) {
        throw new BadRequestException('Text snippet category not found');
      }
    }

    const newSnippet: NewTextSnippet = {
      workspaceId,
      createdById: userId,
      name: dto.name,
      snippetType: dto.snippetType,
      content: dto.content,
      categoryId: dto.categoryId,
      tags: dto.tags || [],
    };

    const [created] = await this.db
      .insert(textSnippets)
      .values(newSnippet)
      .returning();

    this.logger.log(
      `Created text snippet "${dto.name}" for workspace ${workspaceId}`,
    );

    return created;
  }

  /**
   * The WHERE clause of `GET snippets`, shared with bulk select-all so
   * "every match" means exactly what the list shows.
   */
  buildSnippetConditions(
    workspaceId: string,
    query: TextSnippetQueryDto,
  ): SQL[] {
    const { categoryId, isDeleted = false, search } = query;
    // Contract names win over the legacy ones: `type` over `snippetType`,
    // `starred` over `isStarred`.
    const snippetType = query.type ?? query.snippetType;
    const starred = query.starred ?? query.isStarred;

    const conditions: SQL[] = [
      eq(textSnippets.workspaceId, workspaceId),
      eq(textSnippets.isDeleted, isDeleted),
    ];

    if (snippetType) {
      conditions.push(eq(textSnippets.snippetType, snippetType));
    }

    if (categoryId) {
      conditions.push(eq(textSnippets.categoryId, categoryId));
    }

    if (starred !== undefined) {
      conditions.push(eq(textSnippets.isStarred, starred));
    }

    if (search) {
      conditions.push(
        or(
          ilike(textSnippets.name, ilikePattern(search)),
          ilike(textSnippets.content, ilikePattern(search)),
        )!,
      );
    }

    return conditions;
  }

  /**
   * Get all text snippets for a workspace with filtering
   */
  async findAll(workspaceId: string, query: TextSnippetQueryDto = {}) {
    const { limit = 50, offset = 0 } = query;
    const conditions = this.buildSnippetConditions(workspaceId, query);

    const snippets = await this.db
      .select({
        snippet: textSnippets,
        category: mediaCategories,
      })
      .from(textSnippets)
      .leftJoin(
        mediaCategories,
        eq(textSnippets.categoryId, mediaCategories.id),
      )
      .where(and(...conditions))
      .orderBy(...snippetOrder(query.sort))
      .limit(limit)
      .offset(offset);

    // Get total count
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(textSnippets)
      .where(and(...conditions));

    return {
      items: snippets.map((row) => ({
        ...row.snippet,
        category: row.category,
      })),
      total: count,
      limit,
      offset,
    };
  }

  /**
   * Get a single text snippet by ID
   */
  async findOne(workspaceId: string, snippetId: string) {
    const [snippet] = await this.db
      .select({
        snippet: textSnippets,
        category: mediaCategories,
      })
      .from(textSnippets)
      .leftJoin(
        mediaCategories,
        eq(textSnippets.categoryId, mediaCategories.id),
      )
      .where(
        and(
          eq(textSnippets.id, snippetId),
          eq(textSnippets.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (!snippet) {
      throw new NotFoundException('Text snippet not found');
    }

    return {
      ...snippet.snippet,
      category: snippet.category,
    };
  }

  /**
   * Update a text snippet
   */
  async update(
    workspaceId: string,
    snippetId: string,
    dto: UpdateTextSnippetDto,
  ) {
    await this.findOne(workspaceId, snippetId);

    // Validate category if changing
    if (dto.categoryId) {
      const category = await this.db
        .select()
        .from(mediaCategories)
        .where(
          and(
            eq(mediaCategories.id, dto.categoryId),
            eq(mediaCategories.workspaceId, workspaceId),
            eq(mediaCategories.type, 'text_snippet'),
          ),
        )
        .limit(1);

      if (category.length === 0) {
        throw new BadRequestException('Text snippet category not found');
      }
    }

    const updateData: Partial<typeof textSnippets.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.snippetType !== undefined) updateData.snippetType = dto.snippetType;
    if (dto.content !== undefined) updateData.content = dto.content;
    if (dto.categoryId !== undefined) updateData.categoryId = dto.categoryId;
    if (dto.tags !== undefined) updateData.tags = dto.tags;
    if (dto.isStarred !== undefined) updateData.isStarred = dto.isStarred;

    const [updated] = await this.db
      .update(textSnippets)
      .set(updateData)
      .where(eq(textSnippets.id, snippetId))
      .returning();

    this.logger.log(`Updated text snippet ${snippetId}`);

    return updated;
  }

  /**
   * Soft delete a text snippet (move to recycle bin)
   */
  async softDelete(workspaceId: string, snippetId: string, userId: string) {
    await this.findOne(workspaceId, snippetId);

    const [updated] = await this.db
      .update(textSnippets)
      .set({
        isDeleted: true,
        deletedAt: new Date(),
        deletedById: userId,
        updatedAt: new Date(),
      })
      .where(eq(textSnippets.id, snippetId))
      .returning();

    this.logger.log(`Soft deleted text snippet ${snippetId}`);

    return updated;
  }

  /**
   * Restore a text snippet from recycle bin
   */
  async restore(workspaceId: string, snippetId: string) {
    const [snippet] = await this.db
      .select()
      .from(textSnippets)
      .where(
        and(
          eq(textSnippets.id, snippetId),
          eq(textSnippets.workspaceId, workspaceId),
          eq(textSnippets.isDeleted, true),
        ),
      )
      .limit(1);

    if (!snippet) {
      throw new NotFoundException('Text snippet not found in recycle bin');
    }

    const [updated] = await this.db
      .update(textSnippets)
      .set({
        isDeleted: false,
        deletedAt: null,
        deletedById: null,
        updatedAt: new Date(),
      })
      .where(eq(textSnippets.id, snippetId))
      .returning();

    this.logger.log(`Restored text snippet ${snippetId}`);

    return updated;
  }

  /**
   * Permanently delete a text snippet
   */
  async permanentDelete(workspaceId: string, snippetId: string) {
    await this.findOne(workspaceId, snippetId);

    await this.db.delete(textSnippets).where(eq(textSnippets.id, snippetId));

    this.logger.log(`Permanently deleted text snippet ${snippetId}`);

    return { success: true, message: 'Text snippet permanently deleted' };
  }

  /**
   * Record that a snippet was just used: sets `lastUsedAt` only.
   * `usage_count` is a post count kept by the posts trigger (0055, D13).
   */
  async markUsed(workspaceId: string, snippetId: string) {
    // Workspace-scoped so one workspace can't touch another's snippet by id.
    const [updated] = await this.db
      .update(textSnippets)
      .set({
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(textSnippets.id, snippetId),
          eq(textSnippets.workspaceId, workspaceId),
        ),
      )
      .returning();

    if (!updated) {
      throw new NotFoundException('Snippet not found');
    }

    return updated;
  }

  /**
   * Bulk delete / star / unstar / move (ruling 6), on `ids` or with
   * `selectAll` on every snippet the list's filter matches. Rows are written
   * 500 at a time.
   */
  async bulkAction(
    workspaceId: string,
    userId: string,
    dto: SnippetBulkDto,
  ): Promise<{ affectedCount: number }> {
    assertIdsXorSelectAll(dto);

    if (dto.action === 'move') {
      // Omitted is not a move; null is: it unfiles the selection (X1).
      if (dto.categoryId === undefined) {
        throw new BadRequestException('categoryId required for move action');
      }
      if (dto.categoryId !== null) {
        await this.assertSnippetFolder(workspaceId, dto.categoryId);
      }
    }

    const ids = dto.selectAll
      ? (
          await this.db
            .select({ id: textSnippets.id })
            .from(textSnippets)
            .where(
              and(
                ...this.buildSnippetConditions(
                  workspaceId,
                  dto.selectAll.filter,
                ),
              ),
            )
        ).map((r) => r.id)
      : await this.assertSnippetsInWorkspace(workspaceId, dto.ids ?? []);

    const now = new Date();
    const set: Partial<typeof textSnippets.$inferInsert> =
      dto.action === 'delete'
        ? { isDeleted: true, deletedAt: now, deletedById: userId }
        : dto.action === 'move'
          ? { categoryId: dto.categoryId ?? null }
          : { isStarred: dto.action === 'star' };

    let affectedCount = 0;
    for (const part of chunk(ids)) {
      const rows = await this.db
        .update(textSnippets)
        .set({ ...set, updatedAt: now })
        .where(
          and(
            inArray(textSnippets.id, part),
            eq(textSnippets.workspaceId, workspaceId),
          ),
        )
        .returning({ id: textSnippets.id });
      affectedCount += rows.length;
    }

    this.logger.log(
      `Bulk ${dto.action} on ${ids.length} text snippets in workspace ${workspaceId}`,
    );

    return { affectedCount };
  }

  /** Explicit bulk ids must all be this workspace's snippets, else 400. */
  private async assertSnippetsInWorkspace(
    workspaceId: string,
    ids: string[],
  ): Promise<string[]> {
    if (ids.length === 0) return ids;
    const found = await this.db
      .select({ id: textSnippets.id })
      .from(textSnippets)
      .where(
        and(
          inArray(textSnippets.id, ids),
          eq(textSnippets.workspaceId, workspaceId),
        ),
      );
    if (found.length !== ids.length) {
      throw new BadRequestException('Some items not found');
    }
    return ids;
  }

  /** A snippet can be filed only into this workspace's snippet folders. */
  private async assertSnippetFolder(
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
      throw new BadRequestException('Text snippet category not found');
    }
    if (folder.type !== 'text_snippet') {
      throw new BadRequestException(
        `Folder "${folder.name}" is not a snippet folder`,
      );
    }
  }

  /**
   * Get snippets in recycle bin
   */
  async getRecycleBin(workspaceId: string, limit = 50, offset = 0) {
    const snippets = await this.db
      .select()
      .from(textSnippets)
      .where(
        and(
          eq(textSnippets.workspaceId, workspaceId),
          eq(textSnippets.isDeleted, true),
        ),
      )
      .orderBy(desc(textSnippets.deletedAt))
      .limit(limit)
      .offset(offset);

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(textSnippets)
      .where(
        and(
          eq(textSnippets.workspaceId, workspaceId),
          eq(textSnippets.isDeleted, true),
        ),
      );

    return {
      items: snippets,
      total: count,
      limit,
      offset,
    };
  }

  /**
   * Cleanup snippets older than 30 days in recycle bin
   */
  async cleanupRecycleBin() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const result = await this.db
      .delete(textSnippets)
      .where(
        and(
          eq(textSnippets.isDeleted, true),
          sql`${textSnippets.deletedAt} < ${thirtyDaysAgo}`,
        ),
      )
      .returning();

    this.logger.log(
      `Cleaned up ${result.length} text snippets from recycle bin (older than 30 days)`,
    );

    return {
      deletedCount: result.length,
    };
  }
}
