import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { eq, and, asc, desc, ilike, or, sql, type SQL } from 'drizzle-orm';
import { ilikePattern } from '../lib/search';
import {
  assertKindFolder,
  runKindBulk,
  type KindBulkConfig,
} from '../lib/bulk';
import { binPurgeCutoff } from '../lib/bin-retention';
import { snippetPostCountSql, withUsageLock } from '../lib/usage-sql';
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
    case 'oldest':
      return [asc(textSnippets.createdAt), asc(textSnippets.id)];
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

const SNIPPET_BULK: KindBulkConfig = {
  table: textSnippets,
  folderKind: 'text_snippet',
  label: 'Text snippet',
};

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
      await assertKindFolder(
        this.db,
        workspaceId,
        dto.categoryId,
        'text_snippet',
        'Text snippet',
      );
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

    // Posts written before the snippet existed may already hold its text (I4).
    return this.recountUsage(workspaceId, created.id);
  }

  /**
   * Sets `usage_count` from the posts that hold the snippet's text, by the
   * 0055 trigger's own test (I4). For writes the trigger cannot see: a new
   * snippet, or changed content. Returns the updated row.
   */
  private recountUsage(workspaceId: string, snippetId: string) {
    return withUsageLock(this.db, workspaceId, async (tx) => {
      const [row] = await tx
        .update(textSnippets)
        .set({
          usageCount: snippetPostCountSql({
            content: textSnippets.content,
            workspaceId: textSnippets.workspaceId,
          }),
        })
        .where(
          and(
            eq(textSnippets.id, snippetId),
            eq(textSnippets.workspaceId, workspaceId),
          ),
        )
        .returning();
      return row;
    });
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
    const existing = await this.findOne(workspaceId, snippetId);

    // Validate category if changing
    if (dto.categoryId) {
      await assertKindFolder(
        this.db,
        workspaceId,
        dto.categoryId,
        'text_snippet',
        'Text snippet',
      );
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

    // The posts trigger counted the old text; the new text needs a recount.
    const isContentChanging =
      dto.content !== undefined && dto.content !== existing.content;
    return isContentChanging
      ? this.recountUsage(workspaceId, snippetId)
      : updated;
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
    // Only a row in the Bin, in this workspace, can be deleted for good.
    const [gone] = await this.db
      .delete(textSnippets)
      .where(
        and(
          eq(textSnippets.id, snippetId),
          eq(textSnippets.workspaceId, workspaceId),
          eq(textSnippets.isDeleted, true),
        ),
      )
      .returning({ id: textSnippets.id });
    if (!gone) {
      throw new NotFoundException('Text snippet not found in recycle bin');
    }

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
   * `selectAll` on every snippet the list's filter matches. The rules
   * (live rows only, X1 move, workspace scope) live in `runKindBulk`.
   */
  bulkAction(
    workspaceId: string,
    userId: string,
    dto: SnippetBulkDto,
  ): Promise<{ affectedCount: number }> {
    return runKindBulk(
      this.db,
      SNIPPET_BULK,
      workspaceId,
      userId,
      dto,
      (ws, q) => this.buildSnippetConditions(ws, q),
    );
  }

  /**
   * Cleanup snippets older than 30 days in recycle bin
   */
  async cleanupRecycleBin(now: Date = new Date()) {
    const cutoff = binPurgeCutoff(now);

    const result = await this.db
      .delete(textSnippets)
      .where(
        and(
          eq(textSnippets.isDeleted, true),
          // Same COALESCE as the Bin's purgeAt (legacy rows lack deleted_at).
          sql`COALESCE(${textSnippets.deletedAt}, ${textSnippets.updatedAt}) < ${cutoff}`,
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
