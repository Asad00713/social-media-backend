import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { eq, and, desc, asc, like, or, sql, inArray } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import {
  mediaTemplates,
  mediaCategories,
  NewMediaTemplate,
} from '../../drizzle/schema/media-library.schema';
import {
  CreateTemplateDto,
  UpdateTemplateDto,
  TemplateQueryDto,
} from '../dto/media-library.dto';

@Injectable()
export class TemplateService {
  private readonly logger = new Logger(TemplateService.name);

  /**
   * Create a new template
   */
  async create(
    workspaceId: string,
    userId: string,
    dto: CreateTemplateDto,
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
            eq(mediaCategories.type, 'template'),
          ),
        )
        .limit(1);

      if (category.length === 0) {
        throw new BadRequestException('Template category not found');
      }
    }

    const newTemplate: NewMediaTemplate = {
      workspaceId,
      createdById: userId,
      name: dto.name,
      description: dto.description,
      templateType: dto.templateType,
      platforms: dto.platforms || [],
      content: dto.content,
      thumbnailUrl: dto.thumbnailUrl,
      categoryId: dto.categoryId,
      tags: dto.tags || [],
    };

    const [created] = await db
      .insert(mediaTemplates)
      .values(newTemplate)
      .returning();

    this.logger.log(
      `Created template "${dto.name}" for workspace ${workspaceId}`,
    );

    return created;
  }

  /**
   * Get all templates for a workspace with filtering
   */
  async findAll(workspaceId: string, query: TemplateQueryDto = {}) {
    const {
      templateType,
      categoryId,
      platform,
      isStarred,
      isDeleted = false,
      search,
      limit = 50,
      offset = 0,
    } = query;

    const conditions = [
      eq(mediaTemplates.workspaceId, workspaceId),
      eq(mediaTemplates.isDeleted, isDeleted),
    ];

    if (templateType) {
      conditions.push(eq(mediaTemplates.templateType, templateType));
    }

    if (categoryId) {
      conditions.push(eq(mediaTemplates.categoryId, categoryId));
    }

    if (isStarred !== undefined) {
      conditions.push(eq(mediaTemplates.isStarred, isStarred));
    }

    if (search) {
      conditions.push(
        or(
          like(mediaTemplates.name, `%${search}%`),
          like(mediaTemplates.description, `%${search}%`),
        )!,
      );
    }

    let baseQuery = db
      .select({
        template: mediaTemplates,
        category: mediaCategories,
      })
      .from(mediaTemplates)
      .leftJoin(
        mediaCategories,
        eq(mediaTemplates.categoryId, mediaCategories.id),
      )
      .where(and(...conditions))
      .orderBy(desc(mediaTemplates.createdAt))
      .limit(limit)
      .offset(offset);

    const templates = await baseQuery;

    // Filter by platform if specified (JSON array contains)
    let filteredTemplates = templates;
    if (platform) {
      filteredTemplates = templates.filter((t) =>
        (t.template.platforms as string[])?.includes(platform),
      );
    }

    // Get total count
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(mediaTemplates)
      .where(and(...conditions));

    return {
      items: filteredTemplates.map((row) => ({
        ...row.template,
        category: row.category,
      })),
      total: count,
      limit,
      offset,
    };
  }

  /**
   * Get a single template by ID
   */
  async findOne(workspaceId: string, templateId: string) {
    const [template] = await db
      .select({
        template: mediaTemplates,
        category: mediaCategories,
      })
      .from(mediaTemplates)
      .leftJoin(
        mediaCategories,
        eq(mediaTemplates.categoryId, mediaCategories.id),
      )
      .where(
        and(
          eq(mediaTemplates.id, templateId),
          eq(mediaTemplates.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (!template) {
      throw new NotFoundException('Template not found');
    }

    return {
      ...template.template,
      category: template.category,
    };
  }

  /**
   * Update a template
   */
  async update(
    workspaceId: string,
    templateId: string,
    dto: UpdateTemplateDto,
  ) {
    await this.findOne(workspaceId, templateId);

    // Validate category if changing
    if (dto.categoryId) {
      const category = await db
        .select()
        .from(mediaCategories)
        .where(
          and(
            eq(mediaCategories.id, dto.categoryId),
            eq(mediaCategories.workspaceId, workspaceId),
            eq(mediaCategories.type, 'template'),
          ),
        )
        .limit(1);

      if (category.length === 0) {
        throw new BadRequestException('Template category not found');
      }
    }

    const updateData: Partial<typeof mediaTemplates.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.templateType !== undefined) updateData.templateType = dto.templateType;
    if (dto.platforms !== undefined) updateData.platforms = dto.platforms;
    if (dto.content !== undefined) updateData.content = dto.content;
    if (dto.thumbnailUrl !== undefined) updateData.thumbnailUrl = dto.thumbnailUrl;
    if (dto.categoryId !== undefined) updateData.categoryId = dto.categoryId;
    if (dto.tags !== undefined) updateData.tags = dto.tags;
    if (dto.isStarred !== undefined) updateData.isStarred = dto.isStarred;

    const [updated] = await db
      .update(mediaTemplates)
      .set(updateData)
      .where(eq(mediaTemplates.id, templateId))
      .returning();

    this.logger.log(`Updated template ${templateId}`);

    return updated;
  }

  /**
   * Clone a template
   */
  async clone(
    workspaceId: string,
    userId: string,
    templateId: string,
    newName?: string,
  ) {
    const original = await this.findOne(workspaceId, templateId);

    const cloned: NewMediaTemplate = {
      workspaceId,
      createdById: userId,
      name: newName || `${original.name} (Copy)`,
      description: original.description,
      templateType: original.templateType,
      platforms: original.platforms as string[],
      content: original.content,
      thumbnailUrl: original.thumbnailUrl,
      categoryId: original.categoryId,
      tags: original.tags as string[],
    };

    const [created] = await db
      .insert(mediaTemplates)
      .values(cloned)
      .returning();

    this.logger.log(`Cloned template ${templateId} to ${created.id}`);

    return created;
  }

  /**
   * Soft delete a template (move to recycle bin)
   */
  async softDelete(workspaceId: string, templateId: string, userId: string) {
    await this.findOne(workspaceId, templateId);

    const [updated] = await db
      .update(mediaTemplates)
      .set({
        isDeleted: true,
        deletedAt: new Date(),
        deletedById: userId,
        updatedAt: new Date(),
      })
      .where(eq(mediaTemplates.id, templateId))
      .returning();

    this.logger.log(`Soft deleted template ${templateId}`);

    return updated;
  }

  /**
   * Restore a template from recycle bin
   */
  async restore(workspaceId: string, templateId: string) {
    const [template] = await db
      .select()
      .from(mediaTemplates)
      .where(
        and(
          eq(mediaTemplates.id, templateId),
          eq(mediaTemplates.workspaceId, workspaceId),
          eq(mediaTemplates.isDeleted, true),
        ),
      )
      .limit(1);

    if (!template) {
      throw new NotFoundException('Template not found in recycle bin');
    }

    const [updated] = await db
      .update(mediaTemplates)
      .set({
        isDeleted: false,
        deletedAt: null,
        deletedById: null,
        updatedAt: new Date(),
      })
      .where(eq(mediaTemplates.id, templateId))
      .returning();

    this.logger.log(`Restored template ${templateId}`);

    return updated;
  }

  /**
   * Permanently delete a template
   */
  async permanentDelete(workspaceId: string, templateId: string) {
    await this.findOne(workspaceId, templateId);

    await db.delete(mediaTemplates).where(eq(mediaTemplates.id, templateId));

    this.logger.log(`Permanently deleted template ${templateId}`);

    return { success: true, message: 'Template permanently deleted' };
  }

  /**
   * Increment usage count when template is used
   */
  async incrementUsage(templateId: string) {
    await db
      .update(mediaTemplates)
      .set({
        usageCount: sql`${mediaTemplates.usageCount} + 1`,
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(mediaTemplates.id, templateId));
  }

  /**
   * Get templates in recycle bin
   */
  async getRecycleBin(workspaceId: string, limit = 50, offset = 0) {
    const templates = await db
      .select()
      .from(mediaTemplates)
      .where(
        and(
          eq(mediaTemplates.workspaceId, workspaceId),
          eq(mediaTemplates.isDeleted, true),
        ),
      )
      .orderBy(desc(mediaTemplates.deletedAt))
      .limit(limit)
      .offset(offset);

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(mediaTemplates)
      .where(
        and(
          eq(mediaTemplates.workspaceId, workspaceId),
          eq(mediaTemplates.isDeleted, true),
        ),
      );

    return {
      items: templates,
      total: count,
      limit,
      offset,
    };
  }

  /**
   * Cleanup templates older than 30 days in recycle bin
   */
  async cleanupRecycleBin() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const result = await db
      .delete(mediaTemplates)
      .where(
        and(
          eq(mediaTemplates.isDeleted, true),
          sql`${mediaTemplates.deletedAt} < ${thirtyDaysAgo}`,
        ),
      )
      .returning();

    this.logger.log(
      `Cleaned up ${result.length} templates from recycle bin (older than 30 days)`,
    );

    return {
      deletedCount: result.length,
    };
  }
}
