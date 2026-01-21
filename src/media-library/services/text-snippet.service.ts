import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { eq, and, desc, like, or, sql } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import {
  textSnippets,
  mediaCategories,
  NewTextSnippet,
} from '../../drizzle/schema/media-library.schema';
import {
  CreateTextSnippetDto,
  UpdateTextSnippetDto,
  TextSnippetQueryDto,
} from '../dto/media-library.dto';

@Injectable()
export class TextSnippetService {
  private readonly logger = new Logger(TextSnippetService.name);

  /**
   * Create a new text snippet
   */
  async create(
    workspaceId: string,
    userId: string,
    dto: CreateTextSnippetDto,
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

    const [created] = await db
      .insert(textSnippets)
      .values(newSnippet)
      .returning();

    this.logger.log(
      `Created text snippet "${dto.name}" for workspace ${workspaceId}`,
    );

    return created;
  }

  /**
   * Get all text snippets for a workspace with filtering
   */
  async findAll(workspaceId: string, query: TextSnippetQueryDto = {}) {
    const {
      snippetType,
      categoryId,
      isStarred,
      isDeleted = false,
      search,
      limit = 50,
      offset = 0,
    } = query;

    const conditions = [
      eq(textSnippets.workspaceId, workspaceId),
      eq(textSnippets.isDeleted, isDeleted),
    ];

    if (snippetType) {
      conditions.push(eq(textSnippets.snippetType, snippetType));
    }

    if (categoryId) {
      conditions.push(eq(textSnippets.categoryId, categoryId));
    }

    if (isStarred !== undefined) {
      conditions.push(eq(textSnippets.isStarred, isStarred));
    }

    if (search) {
      conditions.push(
        or(
          like(textSnippets.name, `%${search}%`),
          like(textSnippets.content, `%${search}%`),
        )!,
      );
    }

    const snippets = await db
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
      .orderBy(desc(textSnippets.createdAt))
      .limit(limit)
      .offset(offset);

    // Get total count
    const [{ count }] = await db
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
    const [snippet] = await db
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
      const category = await db
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

    const [updated] = await db
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

    const [updated] = await db
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
    const [snippet] = await db
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

    const [updated] = await db
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

    await db.delete(textSnippets).where(eq(textSnippets.id, snippetId));

    this.logger.log(`Permanently deleted text snippet ${snippetId}`);

    return { success: true, message: 'Text snippet permanently deleted' };
  }

  /**
   * Increment usage count when snippet is used
   */
  async incrementUsage(snippetId: string) {
    await db
      .update(textSnippets)
      .set({
        usageCount: sql`${textSnippets.usageCount} + 1`,
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(textSnippets.id, snippetId));
  }

  /**
   * Get snippets in recycle bin
   */
  async getRecycleBin(workspaceId: string, limit = 50, offset = 0) {
    const snippets = await db
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

    const [{ count }] = await db
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

    const result = await db
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
