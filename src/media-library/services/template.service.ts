import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { eq, and, asc, desc, ilike, or, sql, type SQL } from 'drizzle-orm';
import { ilikePattern } from '../lib/search';
import {
  assertKindFolder,
  runKindBulk,
  type KindBulkConfig,
} from '../lib/bulk';
import { binPurgeCutoff } from '../lib/bin-retention';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import {
  mediaTemplates,
  mediaCategories,
  NewMediaTemplate,
  MediaTemplate,
  MediaCategory,
  TemplateContent,
} from '../../drizzle/schema/media-library.schema';
import { users } from '../../drizzle/schema/users.schema';
import { toUserRef, USER_REF_COLUMNS, type UserRefRow } from '../lib/user-ref';
import type { Page, UserRef } from '../dto/contract';
import {
  CreateTemplateDto,
  TemplateContentDto,
  UpdateTemplateDto,
  TemplateQueryDto,
  TemplateBulkDto,
} from '../dto/media-library.dto';

/**
 * Fill in the parts of `content` a caller left out.
 *
 * The DTO lets a template send only what it uses — a text-only template has no
 * media slots, a media-only one has no hashtags — but what lands in the column
 * is always the complete shape. Readers can then index into `mediaSlots` and
 * `hashtags` without guarding every access.
 */
export function normalizeContent(content: TemplateContentDto): TemplateContent {
  return {
    text: content.text,
    mediaSlots: content.mediaSlots ?? [],
    media: content.media ?? [],
    hashtags: content.hashtags ?? [],
    defaultCaption: content.defaultCaption,
    // Left OUT rather than stored empty: a template that keeps no channel
    // settings reads the same as one written before they existed.
    ...(content.platformSettings
      ? { platformSettings: content.platformSettings }
      : {}),
    ...(content.firstComments ? { firstComments: content.firstComments } : {}),
  };
}

/**
 * ORDER BY for `GET templates` (ruling 7). Every order ends in `id DESC` so
 * ties keep their place across updates.
 */
function templateOrder(sort: TemplateQueryDto['sort']): SQL[] {
  const byNewest = [desc(mediaTemplates.createdAt), desc(mediaTemplates.id)];
  switch (sort) {
    case 'oldest':
      return [asc(mediaTemplates.createdAt), asc(mediaTemplates.id)];
    case 'most_used':
      return [sql`${mediaTemplates.usageCount} DESC NULLS LAST`, ...byNewest];
    case 'recently_used':
      return [sql`${mediaTemplates.lastUsedAt} DESC NULLS LAST`, ...byNewest];
    case 'name':
      return [sql`lower(${mediaTemplates.name}) ASC`, ...byNewest];
    default:
      return byNewest;
  }
}

/** A template as the list, the detail and every single-item write return it. */
export type TemplateView = MediaTemplate & {
  category: MediaCategory | null;
  createdBy: UserRef | null;
};

/** The columns a `TemplateView` is read from; folder and creator left-joined. */
const VIEW_SELECTION = {
  template: mediaTemplates,
  category: mediaCategories,
  creator: USER_REF_COLUMNS,
};

function toTemplateView(row: {
  template: MediaTemplate;
  category: MediaCategory | null;
  creator: UserRefRow | null;
}): TemplateView {
  return {
    ...row.template,
    category: row.category,
    createdBy: toUserRef(row.creator),
  };
}

const TEMPLATE_BULK: KindBulkConfig = {
  table: mediaTemplates,
  folderKind: 'template',
  label: 'Template',
};

@Injectable()
export class TemplateService {
  private readonly logger = new Logger(TemplateService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /**
   * Create a new template
   */
  async create(
    workspaceId: string,
    userId: string,
    dto: CreateTemplateDto,
  ): Promise<TemplateView> {
    // Validate category if provided
    if (dto.categoryId) {
      await assertKindFolder(
        this.db,
        workspaceId,
        dto.categoryId,
        'template',
        'Template',
      );
    }

    const newTemplate: NewMediaTemplate = {
      workspaceId,
      createdById: userId,
      name: dto.name,
      description: dto.description,
      templateType: dto.templateType,
      platforms: dto.platforms || [],
      content: normalizeContent(dto.content),
      thumbnailUrl: dto.thumbnailUrl,
      categoryId: dto.categoryId,
      tags: dto.tags || [],
    };

    const [created] = await this.db
      .insert(mediaTemplates)
      .values(newTemplate)
      .returning();

    this.logger.log(
      `Created template "${dto.name}" for workspace ${workspaceId}`,
    );

    return this.findOne(workspaceId, created.id);
  }

  /**
   * The WHERE clause of `GET templates`, shared with bulk select-all so
   * "every match" means exactly what the list shows.
   */
  buildTemplateConditions(workspaceId: string, query: TemplateQueryDto): SQL[] {
    const {
      templateType,
      categoryId,
      platform,
      isDeleted = false,
      search,
      createdBy,
    } = query;
    // `starred` is the contract name and wins over the legacy `isStarred`.
    const starred = query.starred ?? query.isStarred;

    const conditions: SQL[] = [
      eq(mediaTemplates.workspaceId, workspaceId),
      eq(mediaTemplates.isDeleted, isDeleted),
    ];

    if (createdBy) {
      conditions.push(eq(mediaTemplates.createdById, createdBy));
    }

    if (templateType) {
      conditions.push(eq(mediaTemplates.templateType, templateType));
    }

    if (categoryId) {
      conditions.push(eq(mediaTemplates.categoryId, categoryId));
    }

    // In SQL rather than on the fetched page, so the total and a select-all
    // count the same rows the list shows.
    if (platform) {
      conditions.push(
        sql`${mediaTemplates.platforms} @> ${JSON.stringify([platform])}::jsonb`,
      );
    }

    if (starred !== undefined) {
      conditions.push(eq(mediaTemplates.isStarred, starred));
    }

    if (search) {
      conditions.push(
        or(
          ilike(mediaTemplates.name, ilikePattern(search)),
          ilike(mediaTemplates.description, ilikePattern(search)),
        )!,
      );
    }

    return conditions;
  }

  /**
   * Get all templates for a workspace with filtering. `most_used` ranks by
   * `usage_count`, which for templates counts picks (D13).
   */
  async findAll(
    workspaceId: string,
    query: TemplateQueryDto = {},
  ): Promise<Page<TemplateView>> {
    const { limit = 50, offset = 0 } = query;
    const conditions = this.buildTemplateConditions(workspaceId, query);

    // Both joins are on a primary key, so each template stays one row and
    // LIMIT/OFFSET and the count still agree.
    const templates = await this.db
      .select(VIEW_SELECTION)
      .from(mediaTemplates)
      .leftJoin(
        mediaCategories,
        eq(mediaTemplates.categoryId, mediaCategories.id),
      )
      .leftJoin(users, eq(mediaTemplates.createdById, users.id))
      .where(and(...conditions))
      .orderBy(...templateOrder(query.sort))
      .limit(limit)
      .offset(offset);

    // Get total count
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(mediaTemplates)
      .where(and(...conditions));

    return {
      items: templates.map(toTemplateView),
      total: count,
      limit,
      offset,
    };
  }

  /**
   * Get a single template by ID
   */
  async findOne(
    workspaceId: string,
    templateId: string,
  ): Promise<TemplateView> {
    const [template] = await this.db
      .select(VIEW_SELECTION)
      .from(mediaTemplates)
      .leftJoin(
        mediaCategories,
        eq(mediaTemplates.categoryId, mediaCategories.id),
      )
      .leftJoin(users, eq(mediaTemplates.createdById, users.id))
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

    return toTemplateView(template);
  }

  /**
   * Update a template
   */
  async update(
    workspaceId: string,
    templateId: string,
    dto: UpdateTemplateDto,
  ): Promise<TemplateView> {
    await this.findOne(workspaceId, templateId);

    // Validate category if changing
    if (dto.categoryId) {
      await assertKindFolder(
        this.db,
        workspaceId,
        dto.categoryId,
        'template',
        'Template',
      );
    }

    const updateData: Partial<typeof mediaTemplates.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.templateType !== undefined)
      updateData.templateType = dto.templateType;
    if (dto.platforms !== undefined) updateData.platforms = dto.platforms;
    if (dto.content !== undefined)
      updateData.content = normalizeContent(dto.content);
    if (dto.thumbnailUrl !== undefined)
      updateData.thumbnailUrl = dto.thumbnailUrl;
    if (dto.categoryId !== undefined) updateData.categoryId = dto.categoryId;
    if (dto.tags !== undefined) updateData.tags = dto.tags;
    if (dto.isStarred !== undefined) updateData.isStarred = dto.isStarred;

    await this.db
      .update(mediaTemplates)
      .set(updateData)
      .where(
        and(
          eq(mediaTemplates.id, templateId),
          eq(mediaTemplates.workspaceId, workspaceId),
        ),
      );

    this.logger.log(`Updated template ${templateId}`);

    return this.findOne(workspaceId, templateId);
  }

  /**
   * Clone a template
   */
  async clone(
    workspaceId: string,
    userId: string,
    templateId: string,
    newName?: string,
  ): Promise<TemplateView> {
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

    const [created] = await this.db
      .insert(mediaTemplates)
      .values(cloned)
      .returning();

    this.logger.log(`Cloned template ${templateId} to ${created.id}`);

    return this.findOne(workspaceId, created.id);
  }

  /**
   * Soft delete a template (move to recycle bin)
   */
  async softDelete(
    workspaceId: string,
    templateId: string,
    userId: string,
  ): Promise<TemplateView> {
    await this.findOne(workspaceId, templateId);

    await this.db
      .update(mediaTemplates)
      .set({
        isDeleted: true,
        deletedAt: new Date(),
        deletedById: userId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(mediaTemplates.id, templateId),
          eq(mediaTemplates.workspaceId, workspaceId),
        ),
      );

    this.logger.log(`Soft deleted template ${templateId}`);

    return this.findOne(workspaceId, templateId);
  }

  /**
   * Restore a template from recycle bin
   */
  async restore(
    workspaceId: string,
    templateId: string,
  ): Promise<TemplateView> {
    const [template] = await this.db
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

    await this.db
      .update(mediaTemplates)
      .set({
        isDeleted: false,
        deletedAt: null,
        deletedById: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(mediaTemplates.id, templateId),
          eq(mediaTemplates.workspaceId, workspaceId),
        ),
      );

    this.logger.log(`Restored template ${templateId}`);

    return this.findOne(workspaceId, templateId);
  }

  /**
   * Permanently delete a template
   */
  async permanentDelete(workspaceId: string, templateId: string) {
    // Only a row in the Bin, in this workspace, can be deleted for good.
    const [gone] = await this.db
      .delete(mediaTemplates)
      .where(
        and(
          eq(mediaTemplates.id, templateId),
          eq(mediaTemplates.workspaceId, workspaceId),
          eq(mediaTemplates.isDeleted, true),
        ),
      )
      .returning({ id: mediaTemplates.id });
    if (!gone) {
      throw new NotFoundException('Template not found in recycle bin');
    }

    this.logger.log(`Permanently deleted template ${templateId}`);

    return { success: true, message: 'Template permanently deleted' };
  }

  /**
   * Increment usage count when template is used
   */
  async incrementUsage(
    workspaceId: string,
    templateId: string,
  ): Promise<TemplateView> {
    // Workspace-scoped so one workspace can't bump another's counter by id —
    // the same hole that was closed on media items.
    const [updated] = await this.db
      .update(mediaTemplates)
      .set({
        usageCount: sql`${mediaTemplates.usageCount} + 1`,
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(mediaTemplates.id, templateId),
          eq(mediaTemplates.workspaceId, workspaceId),
        ),
      )
      .returning({ id: mediaTemplates.id });

    if (!updated) {
      throw new NotFoundException('Template not found');
    }

    return this.findOne(workspaceId, templateId);
  }

  /**
   * Bulk delete / star / unstar / move (ruling 6), on `ids` or with
   * `selectAll` on every template the list's filter matches. The rules
   * (live rows only, X1 move, workspace scope) live in `runKindBulk`.
   */
  bulkAction(
    workspaceId: string,
    userId: string,
    dto: TemplateBulkDto,
  ): Promise<{ affectedCount: number }> {
    return runKindBulk(
      this.db,
      TEMPLATE_BULK,
      workspaceId,
      userId,
      dto,
      (ws, q) => this.buildTemplateConditions(ws, q),
    );
  }

  /**
   * Cleanup templates older than 30 days in recycle bin
   */
  async cleanupRecycleBin(now: Date = new Date()) {
    const cutoff = binPurgeCutoff(now);

    const result = await this.db
      .delete(mediaTemplates)
      .where(
        and(
          eq(mediaTemplates.isDeleted, true),
          // Same COALESCE as the Bin's purgeAt (legacy rows lack deleted_at).
          sql`COALESCE(${mediaTemplates.deletedAt}, ${mediaTemplates.updatedAt}) < ${cutoff}`,
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
