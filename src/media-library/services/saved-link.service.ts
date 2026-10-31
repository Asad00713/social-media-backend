import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { eq, and, desc, asc, ilike, or, sql, type SQL } from 'drizzle-orm';
import { ilikePattern } from '../lib/search';
import {
  extractPageMeta,
  fetchPublicHtml,
  normalizeUtm,
} from '../lib/link-meta';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import {
  savedLinks,
  mediaCategories,
  NewSavedLink,
} from '../../drizzle/schema/media-library.schema';
import {
  CreateSavedLinkDto,
  UpdateSavedLinkDto,
  SavedLinkQueryDto,
  LinkBulkDto,
} from '../dto/media-library.dto';
import {
  assertKindFolder,
  runKindBulk,
  type KindBulkConfig,
} from '../lib/bulk';
import { binPurgeCutoff } from '../lib/bin-retention';

const LINK_BULK: KindBulkConfig = {
  table: savedLinks,
  folderKind: 'link',
  label: 'Link',
};

/** ORDER BY for `GET links`. `oldest` = created_at ASC, id ASC (contract). */
function linkOrder(sort: SavedLinkQueryDto['sort']): SQL[] {
  switch (sort) {
    case 'oldest':
      return [asc(savedLinks.createdAt), asc(savedLinks.id)];
    case 'most_used':
      return [
        sql`${savedLinks.usageCount} DESC NULLS LAST`,
        desc(savedLinks.createdAt),
        desc(savedLinks.id),
      ];
    case 'name':
      return [sql`lower(${savedLinks.name}) ASC`, asc(savedLinks.id)];
    default:
      return [desc(savedLinks.createdAt), desc(savedLinks.id)];
  }
}

@Injectable()
export class SavedLinkService {
  private readonly logger = new Logger(SavedLinkService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /**
   * Fetch link preview metadata from URL
   */
  private async fetchLinkPreview(url: string): Promise<{
    title?: string;
    description?: string;
    imageUrl?: string;
    siteName?: string;
    faviconUrl?: string;
  }> {
    try {
      // Public hosts only, capped and time-boxed (see fetchPublicHtml).
      const page = await fetchPublicHtml(url, {
        'User-Agent':
          'Mozilla/5.0 (compatible; SocialMediaBot/1.0; +https://example.com)',
      });
      if (!page) {
        return {};
      }
      return extractPageMeta(page.html, page.finalUrl);
    } catch (error) {
      this.logger.warn(`Failed to fetch link preview for ${url}:`, error);
      return {};
    }
  }

  /**
   * Create a new saved link
   */
  async create(workspaceId: string, userId: string, dto: CreateSavedLinkDto) {
    // Validate category if provided
    if (dto.categoryId) {
      await assertKindFolder(
        this.db,
        workspaceId,
        dto.categoryId,
        'link',
        'Link',
      );
    }

    // Fetch link preview
    const preview = await this.fetchLinkPreview(dto.url);

    const newLink: NewSavedLink = {
      workspaceId,
      createdById: userId,
      name: dto.name,
      url: dto.url,
      description: dto.description,
      previewTitle: preview.title,
      previewDescription: preview.description,
      previewImageUrl: preview.imageUrl,
      previewSiteName: preview.siteName,
      previewFaviconUrl: preview.faviconUrl,
      utm: normalizeUtm(dto.utm),
      categoryId: dto.categoryId,
      tags: dto.tags || [],
    };

    const [created] = await this.db
      .insert(savedLinks)
      .values(newLink)
      .returning();

    this.logger.log(
      `Created saved link "${dto.name}" for workspace ${workspaceId}`,
    );

    return created;
  }

  /**
   * Get all saved links for a workspace with filtering
   */
  async findAll(workspaceId: string, query: SavedLinkQueryDto = {}) {
    const { sort = 'newest', limit = 50, offset = 0 } = query;
    const conditions = this.buildLinkConditions(workspaceId, query);

    const links = await this.db
      .select({
        link: savedLinks,
        category: mediaCategories,
      })
      .from(savedLinks)
      .leftJoin(mediaCategories, eq(savedLinks.categoryId, mediaCategories.id))
      .where(and(...conditions))
      .orderBy(...linkOrder(sort))
      .limit(limit)
      .offset(offset);

    // Get total count
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(savedLinks)
      .where(and(...conditions));

    return {
      items: links.map((row) => ({
        ...row.link,
        category: row.category,
      })),
      total: count,
      limit,
      offset,
    };
  }

  /**
   * Get a single saved link by ID
   */
  async findOne(workspaceId: string, linkId: string) {
    const [link] = await this.db
      .select({
        link: savedLinks,
        category: mediaCategories,
      })
      .from(savedLinks)
      .leftJoin(mediaCategories, eq(savedLinks.categoryId, mediaCategories.id))
      .where(
        and(eq(savedLinks.id, linkId), eq(savedLinks.workspaceId, workspaceId)),
      )
      .limit(1);

    if (!link) {
      throw new NotFoundException('Saved link not found');
    }

    return {
      ...link.link,
      category: link.category,
    };
  }

  /**
   * Update a saved link
   */
  async update(workspaceId: string, linkId: string, dto: UpdateSavedLinkDto) {
    const existing = await this.findOne(workspaceId, linkId);

    // Validate category if changing
    if (dto.categoryId) {
      await assertKindFolder(
        this.db,
        workspaceId,
        dto.categoryId,
        'link',
        'Link',
      );
    }

    const updateData: Partial<typeof savedLinks.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.categoryId !== undefined) updateData.categoryId = dto.categoryId;
    if (dto.tags !== undefined) updateData.tags = dto.tags;
    if (dto.isStarred !== undefined) updateData.isStarred = dto.isStarred;
    if (dto.utm !== undefined) updateData.utm = normalizeUtm(dto.utm);

    // If URL is changing, fetch new preview
    if (dto.url !== undefined && dto.url !== existing.url) {
      updateData.url = dto.url;
      const preview = await this.fetchLinkPreview(dto.url);
      updateData.previewTitle = preview.title;
      updateData.previewDescription = preview.description;
      updateData.previewImageUrl = preview.imageUrl;
      updateData.previewSiteName = preview.siteName;
      updateData.previewFaviconUrl = preview.faviconUrl ?? null;
    }

    const [updated] = await this.db
      .update(savedLinks)
      .set(updateData)
      .where(eq(savedLinks.id, linkId))
      .returning();

    this.logger.log(`Updated saved link ${linkId}`);

    return updated;
  }

  /**
   * Refresh link preview metadata
   */
  async refreshPreview(workspaceId: string, linkId: string) {
    const existing = await this.findOne(workspaceId, linkId);

    const preview = await this.fetchLinkPreview(existing.url);

    const [updated] = await this.db
      .update(savedLinks)
      .set({
        previewTitle: preview.title,
        previewDescription: preview.description,
        previewImageUrl: preview.imageUrl,
        previewSiteName: preview.siteName,
        previewFaviconUrl: preview.faviconUrl ?? null,
        updatedAt: new Date(),
      })
      .where(eq(savedLinks.id, linkId))
      .returning();

    this.logger.log(`Refreshed preview for saved link ${linkId}`);

    return updated;
  }

  /**
   * Soft delete a saved link (move to recycle bin)
   */
  async softDelete(workspaceId: string, linkId: string, userId: string) {
    await this.findOne(workspaceId, linkId);

    const [updated] = await this.db
      .update(savedLinks)
      .set({
        isDeleted: true,
        deletedAt: new Date(),
        deletedById: userId,
        updatedAt: new Date(),
      })
      .where(eq(savedLinks.id, linkId))
      .returning();

    this.logger.log(`Soft deleted saved link ${linkId}`);

    return updated;
  }

  /**
   * Restore a saved link from recycle bin
   */
  async restore(workspaceId: string, linkId: string) {
    const [link] = await this.db
      .select()
      .from(savedLinks)
      .where(
        and(
          eq(savedLinks.id, linkId),
          eq(savedLinks.workspaceId, workspaceId),
          eq(savedLinks.isDeleted, true),
        ),
      )
      .limit(1);

    if (!link) {
      throw new NotFoundException('Saved link not found in recycle bin');
    }

    const [updated] = await this.db
      .update(savedLinks)
      .set({
        isDeleted: false,
        deletedAt: null,
        deletedById: null,
        updatedAt: new Date(),
      })
      .where(eq(savedLinks.id, linkId))
      .returning();

    this.logger.log(`Restored saved link ${linkId}`);

    return updated;
  }

  /**
   * Permanently delete a saved link
   */
  async permanentDelete(workspaceId: string, linkId: string) {
    // Only a row in the Bin, in this workspace, can be deleted for good.
    const [gone] = await this.db
      .delete(savedLinks)
      .where(
        and(
          eq(savedLinks.id, linkId),
          eq(savedLinks.workspaceId, workspaceId),
          eq(savedLinks.isDeleted, true),
        ),
      )
      .returning({ id: savedLinks.id });
    if (!gone) {
      throw new NotFoundException('Link not found in recycle bin');
    }

    this.logger.log(`Permanently deleted saved link ${linkId}`);

    return { success: true, message: 'Saved link permanently deleted' };
  }

  /**
   * Record that a link was just used: sets `lastUsedAt` only.
   * `usage_count` is a post count kept by the posts trigger (0055, D13).
   */
  async markUsed(workspaceId: string, linkId: string) {
    // Workspace-scoped so one workspace can't touch another's link by id.
    const [updated] = await this.db
      .update(savedLinks)
      .set({
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(eq(savedLinks.id, linkId), eq(savedLinks.workspaceId, workspaceId)),
      )
      .returning();

    if (!updated) {
      throw new NotFoundException('Link not found');
    }

    return updated;
  }

  /**
   * The WHERE clause of `GET links`, for bulk select-all. It must match the
   * filters `findAll` applies, so "every match" means what the list shows.
   */
  buildLinkConditions(workspaceId: string, query: SavedLinkQueryDto): SQL[] {
    const { categoryId, isStarred, isDeleted = false, search } = query;

    const conditions: SQL[] = [
      eq(savedLinks.workspaceId, workspaceId),
      eq(savedLinks.isDeleted, isDeleted),
    ];

    if (categoryId) {
      conditions.push(eq(savedLinks.categoryId, categoryId));
    }

    if (isStarred !== undefined) {
      conditions.push(eq(savedLinks.isStarred, isStarred));
    }

    if (search) {
      conditions.push(
        or(
          ilike(savedLinks.name, ilikePattern(search)),
          ilike(savedLinks.url, ilikePattern(search)),
          ilike(savedLinks.description, ilikePattern(search)),
          ilike(savedLinks.previewTitle, ilikePattern(search)),
        )!,
      );
    }

    return conditions;
  }

  /**
   * Bulk delete / star / unstar / move (ruling 6), on `ids` or with
   * `selectAll` on every link the list's filter matches. The rules
   * (live rows only, X1 move, workspace scope) live in `runKindBulk`.
   */
  bulkAction(
    workspaceId: string,
    userId: string,
    dto: LinkBulkDto,
  ): Promise<{ affectedCount: number }> {
    return runKindBulk(this.db, LINK_BULK, workspaceId, userId, dto, (ws, q) =>
      this.buildLinkConditions(ws, q),
    );
  }

  /**
   * Cleanup links older than 30 days in recycle bin
   */
  async cleanupRecycleBin(now: Date = new Date()) {
    const cutoff = binPurgeCutoff(now);

    const result = await this.db
      .delete(savedLinks)
      .where(
        and(
          eq(savedLinks.isDeleted, true),
          // Same COALESCE as the Bin's purgeAt (legacy rows lack deleted_at).
          sql`COALESCE(${savedLinks.deletedAt}, ${savedLinks.updatedAt}) < ${cutoff}`,
        ),
      )
      .returning();

    this.logger.log(
      `Cleaned up ${result.length} saved links from recycle bin (older than 30 days)`,
    );

    return {
      deletedCount: result.length,
    };
  }
}
