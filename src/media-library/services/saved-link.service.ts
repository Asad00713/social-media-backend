import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { eq, and, desc, ilike, or, sql, inArray, type SQL } from 'drizzle-orm';
import { ilikePattern } from '../lib/search';
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
import { assertIdsXorSelectAll, chunk } from '../lib/bulk';

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
  }> {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; SocialMediaBot/1.0; +https://example.com)',
        },
      });

      if (!response.ok) {
        return {};
      }

      const html = await response.text();

      // Extract Open Graph metadata
      const ogTitle = html.match(
        /<meta[^>]*property="og:title"[^>]*content="([^"]*)"[^>]*>/i,
      );
      const ogDescription = html.match(
        /<meta[^>]*property="og:description"[^>]*content="([^"]*)"[^>]*>/i,
      );
      const ogImage = html.match(
        /<meta[^>]*property="og:image"[^>]*content="([^"]*)"[^>]*>/i,
      );
      const ogSiteName = html.match(
        /<meta[^>]*property="og:site_name"[^>]*content="([^"]*)"[^>]*>/i,
      );

      // Fallback to regular meta tags
      const metaTitle = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      const metaDescription = html.match(
        /<meta[^>]*name="description"[^>]*content="([^"]*)"[^>]*>/i,
      );

      return {
        title: ogTitle?.[1] || metaTitle?.[1] || undefined,
        description: ogDescription?.[1] || metaDescription?.[1] || undefined,
        imageUrl: ogImage?.[1] || undefined,
        siteName: ogSiteName?.[1] || undefined,
      };
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
      const category = await this.db
        .select()
        .from(mediaCategories)
        .where(
          and(
            eq(mediaCategories.id, dto.categoryId),
            eq(mediaCategories.workspaceId, workspaceId),
            eq(mediaCategories.type, 'link'),
          ),
        )
        .limit(1);

      if (category.length === 0) {
        throw new BadRequestException('Link category not found');
      }
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
    const {
      categoryId,
      isStarred,
      isDeleted = false,
      search,
      limit = 50,
      offset = 0,
    } = query;

    const conditions = [
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

    const links = await this.db
      .select({
        link: savedLinks,
        category: mediaCategories,
      })
      .from(savedLinks)
      .leftJoin(mediaCategories, eq(savedLinks.categoryId, mediaCategories.id))
      .where(and(...conditions))
      .orderBy(desc(savedLinks.createdAt))
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
      const category = await this.db
        .select()
        .from(mediaCategories)
        .where(
          and(
            eq(mediaCategories.id, dto.categoryId),
            eq(mediaCategories.workspaceId, workspaceId),
            eq(mediaCategories.type, 'link'),
          ),
        )
        .limit(1);

      if (category.length === 0) {
        throw new BadRequestException('Link category not found');
      }
    }

    const updateData: Partial<typeof savedLinks.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.categoryId !== undefined) updateData.categoryId = dto.categoryId;
    if (dto.tags !== undefined) updateData.tags = dto.tags;
    if (dto.isStarred !== undefined) updateData.isStarred = dto.isStarred;

    // If URL is changing, fetch new preview
    if (dto.url !== undefined && dto.url !== existing.url) {
      updateData.url = dto.url;
      const preview = await this.fetchLinkPreview(dto.url);
      updateData.previewTitle = preview.title;
      updateData.previewDescription = preview.description;
      updateData.previewImageUrl = preview.imageUrl;
      updateData.previewSiteName = preview.siteName;
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
    await this.findOne(workspaceId, linkId);

    await this.db.delete(savedLinks).where(eq(savedLinks.id, linkId));

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
   * `selectAll` on every link the list's filter matches. Rows are written
   * 500 at a time.
   */
  async bulkAction(
    workspaceId: string,
    userId: string,
    dto: LinkBulkDto,
  ): Promise<{ affectedCount: number }> {
    assertIdsXorSelectAll(dto);

    if (dto.action === 'move') {
      // Omitted is not a move; null is: it unfiles the selection (X1).
      if (dto.categoryId === undefined) {
        throw new BadRequestException('categoryId required for move action');
      }
      if (dto.categoryId !== null) {
        await this.assertLinkFolder(workspaceId, dto.categoryId);
      }
    }

    const ids = dto.selectAll
      ? (
          await this.db
            .select({ id: savedLinks.id })
            .from(savedLinks)
            .where(
              and(
                ...this.buildLinkConditions(workspaceId, dto.selectAll.filter),
              ),
            )
        ).map((r) => r.id)
      : await this.assertLinksInWorkspace(workspaceId, dto.ids ?? []);

    const now = new Date();
    const set: Partial<typeof savedLinks.$inferInsert> =
      dto.action === 'delete'
        ? { isDeleted: true, deletedAt: now, deletedById: userId }
        : dto.action === 'move'
          ? { categoryId: dto.categoryId ?? null }
          : { isStarred: dto.action === 'star' };

    let affectedCount = 0;
    for (const part of chunk(ids)) {
      const rows = await this.db
        .update(savedLinks)
        .set({ ...set, updatedAt: now })
        .where(
          and(
            inArray(savedLinks.id, part),
            eq(savedLinks.workspaceId, workspaceId),
          ),
        )
        .returning({ id: savedLinks.id });
      affectedCount += rows.length;
    }

    this.logger.log(
      `Bulk ${dto.action} on ${ids.length} saved links in workspace ${workspaceId}`,
    );

    return { affectedCount };
  }

  /** Explicit bulk ids must all be this workspace's links, else 400. */
  private async assertLinksInWorkspace(
    workspaceId: string,
    ids: string[],
  ): Promise<string[]> {
    if (ids.length === 0) return ids;
    const found = await this.db
      .select({ id: savedLinks.id })
      .from(savedLinks)
      .where(
        and(
          inArray(savedLinks.id, ids),
          eq(savedLinks.workspaceId, workspaceId),
        ),
      );
    if (found.length !== ids.length) {
      throw new BadRequestException('Some items not found');
    }
    return ids;
  }

  /** A link can be filed only into this workspace's link folders. */
  private async assertLinkFolder(
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
      throw new BadRequestException('Link category not found');
    }
    if (folder.type !== 'link') {
      throw new BadRequestException(
        `Folder "${folder.name}" is not a link folder`,
      );
    }
  }

  /**
   * Get links in recycle bin
   */
  async getRecycleBin(workspaceId: string, limit = 50, offset = 0) {
    const links = await this.db
      .select()
      .from(savedLinks)
      .where(
        and(
          eq(savedLinks.workspaceId, workspaceId),
          eq(savedLinks.isDeleted, true),
        ),
      )
      .orderBy(desc(savedLinks.deletedAt))
      .limit(limit)
      .offset(offset);

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(savedLinks)
      .where(
        and(
          eq(savedLinks.workspaceId, workspaceId),
          eq(savedLinks.isDeleted, true),
        ),
      );

    return {
      items: links,
      total: count,
      limit,
      offset,
    };
  }

  /**
   * Cleanup links older than 30 days in recycle bin
   */
  async cleanupRecycleBin() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const result = await this.db
      .delete(savedLinks)
      .where(
        and(
          eq(savedLinks.isDeleted, true),
          sql`${savedLinks.deletedAt} < ${thirtyDaysAgo}`,
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
