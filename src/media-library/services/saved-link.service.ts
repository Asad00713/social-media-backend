import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { eq, and, desc, like, or, sql } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import {
  savedLinks,
  mediaCategories,
  NewSavedLink,
} from '../../drizzle/schema/media-library.schema';
import {
  CreateSavedLinkDto,
  UpdateSavedLinkDto,
  SavedLinkQueryDto,
} from '../dto/media-library.dto';

@Injectable()
export class SavedLinkService {
  private readonly logger = new Logger(SavedLinkService.name);

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
  async create(
    workspaceId: string,
    userId: string,
    dto: CreateSavedLinkDto,
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

    const [created] = await db
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
          like(savedLinks.name, `%${search}%`),
          like(savedLinks.url, `%${search}%`),
          like(savedLinks.description, `%${search}%`),
        )!,
      );
    }

    const links = await db
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
    const [{ count }] = await db
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
    const [link] = await db
      .select({
        link: savedLinks,
        category: mediaCategories,
      })
      .from(savedLinks)
      .leftJoin(mediaCategories, eq(savedLinks.categoryId, mediaCategories.id))
      .where(
        and(
          eq(savedLinks.id, linkId),
          eq(savedLinks.workspaceId, workspaceId),
        ),
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
  async update(
    workspaceId: string,
    linkId: string,
    dto: UpdateSavedLinkDto,
  ) {
    const existing = await this.findOne(workspaceId, linkId);

    // Validate category if changing
    if (dto.categoryId) {
      const category = await db
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

    const [updated] = await db
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

    const [updated] = await db
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

    const [updated] = await db
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
    const [link] = await db
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

    const [updated] = await db
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

    await db.delete(savedLinks).where(eq(savedLinks.id, linkId));

    this.logger.log(`Permanently deleted saved link ${linkId}`);

    return { success: true, message: 'Saved link permanently deleted' };
  }

  /**
   * Increment usage count when link is used
   */
  async incrementUsage(linkId: string) {
    await db
      .update(savedLinks)
      .set({
        usageCount: sql`${savedLinks.usageCount} + 1`,
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(savedLinks.id, linkId));
  }

  /**
   * Get links in recycle bin
   */
  async getRecycleBin(workspaceId: string, limit = 50, offset = 0) {
    const links = await db
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

    const [{ count }] = await db
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

    const result = await db
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
