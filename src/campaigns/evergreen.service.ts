import { Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { db } from '../drizzle/db';
import {
  campaigns,
  type Campaign,
  type CampaignScheduleEvergreenJson,
} from '../drizzle/schema/campaigns.schema';
import {
  evergreenCategories,
  evergreenPosts,
  type EvergreenCategory,
  type EvergreenPost,
  type RecyclePolicyJson,
} from '../drizzle/schema/evergreen.schema';
import { computeNextCategoryFire } from './evergreen-rotation.util';
import type {
  CreateEvergreenCampaignDto,
  CreateEvergreenCategoryDto,
  UpdateEvergreenCategoryDto,
  CreateEvergreenPostDto,
  UpdateEvergreenPostDto,
} from './dto/evergreen.dto';

// ==========================================================================
// Response DTO — extends the existing `CampaignDto` shape (see
// `CampaignsService.assembleCampaign`) with evergreen-specific nesting.
//
// Return-shape note (for later tasks): evergreen campaigns don't use the
// bulk/drip `campaignDays`/`campaignSlotContent` tables at all — categories +
// pool posts stand in their place — so `slotContent`/`metrics` are always
// empty/zeroed here rather than omitted, keeping the object a structural
// superset of `CampaignDto` for any shared frontend code that reads those
// fields defensively.
// ==========================================================================

export interface EvergreenPostDto {
  id: string;
  campaignId: string;
  categoryId: string;
  content: EvergreenPost['content'];
  variations: EvergreenPost['variations'];
  recyclePolicy: RecyclePolicyJson;
  minGapHours: number;
  recycledCount: number;
  lastPublishedAt: string | null;
  performanceScore: number | null;
  isStale: boolean;
  staleReason: string | null;
  status: EvergreenPost['status'];
  createdAt: string;
  updatedAt: string;
}

export interface EvergreenCategoryDto {
  id: string;
  campaignId: string;
  name: string;
  color: string;
  schedule: EvergreenCategory['schedule'];
  channelIds: string[];
  seasonal: EvergreenCategory['seasonal'];
  isActive: boolean;
  rotationCursor: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  posts: EvergreenPostDto[];
  /** Next instant this category is due to fire, per Task 2's
   *  `computeNextCategoryFire`. Null when the category has no
   *  weekdays/times configured or nothing falls within the scan window. */
  nextRunAt: string | null;
}

export interface EvergreenCampaignDto {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  type: string;
  status: string;
  channelIds: string[];
  platforms: string[];
  schedule: CampaignScheduleEvergreenJson;
  contentSource: string;
  aiConfig: Record<string, unknown> | null;
  libraryTemplateIds: string[];
  createdAt: string;
  updatedAt: string;
  launchedAt: string | null;
  categories: EvergreenCategoryDto[];
  /** Upcoming occurrences across all categories. Deliberately empty here —
   *  populated once the occurrences table + rotation land (Task 6). */
  upNext: unknown[];
}

@Injectable()
export class EvergreenService {
  constructor() {}

  // ========================================================================
  // Assembly
  // ========================================================================

  /**
   * Loads a campaign row + its categories + each category's pool posts and
   * assembles the nested `EvergreenCampaignDto`, computing each category's
   * `nextRunAt`. `upNext` is always `[]` — Task 6 fills it once occurrences
   * exist. Throws `NotFoundException` if the campaign id doesn't exist.
   */
  async assembleEvergreen(campaignId: string): Promise<EvergreenCampaignDto> {
    const [row] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
    if (!row) {
      throw new NotFoundException('Campaign not found');
    }
    return this.assembleFromRow(row);
  }

  private async assembleFromRow(row: Campaign): Promise<EvergreenCampaignDto> {
    const schedule = row.schedule as CampaignScheduleEvergreenJson;

    const categoryRows = await db
      .select()
      .from(evergreenCategories)
      .where(eq(evergreenCategories.campaignId, row.id));

    const categories: EvergreenCategoryDto[] = await Promise.all(
      categoryRows.map(async (cat) => {
        const postRows = await db
          .select()
          .from(evergreenPosts)
          .where(eq(evergreenPosts.categoryId, cat.id));

        const nextRunAt = computeNextCategoryFire(
          cat.schedule,
          schedule.timezone,
          schedule.blackoutDates ?? [],
          new Date(),
        );

        return this.toCategoryDto(cat, postRows, nextRunAt);
      }),
    );

    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      description: row.description,
      type: row.type,
      status: row.status,
      channelIds: (row.channelIds as string[] | null) ?? [],
      platforms: (row.platforms as string[] | null) ?? [],
      schedule,
      contentSource: row.contentSource,
      aiConfig: row.aiConfig,
      libraryTemplateIds: (row.libraryTemplateIds as string[] | null) ?? [],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      launchedAt: row.launchedAt ? row.launchedAt.toISOString() : null,
      categories,
      upNext: [],
    };
  }

  private toCategoryDto(
    cat: EvergreenCategory,
    posts: EvergreenPost[],
    nextRunAt: Date | null,
  ): EvergreenCategoryDto {
    return {
      id: cat.id,
      campaignId: cat.campaignId,
      name: cat.name,
      color: cat.color,
      schedule: cat.schedule,
      channelIds: (cat.channelIds as string[] | null) ?? [],
      seasonal: cat.seasonal,
      isActive: cat.isActive,
      rotationCursor: cat.rotationCursor,
      sortOrder: cat.sortOrder,
      createdAt: cat.createdAt.toISOString(),
      updatedAt: cat.updatedAt.toISOString(),
      posts: posts.map((p) => this.toPostDto(p)),
      nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
    };
  }

  private toPostDto(post: EvergreenPost): EvergreenPostDto {
    return {
      id: post.id,
      campaignId: post.campaignId,
      categoryId: post.categoryId,
      content: post.content,
      variations: post.variations,
      recyclePolicy: post.recyclePolicy as RecyclePolicyJson,
      minGapHours: post.minGapHours,
      recycledCount: post.recycledCount,
      lastPublishedAt: post.lastPublishedAt ? post.lastPublishedAt.toISOString() : null,
      performanceScore: post.performanceScore,
      isStale: post.isStale,
      staleReason: post.staleReason,
      status: post.status,
      createdAt: post.createdAt.toISOString(),
      updatedAt: post.updatedAt.toISOString(),
    };
  }

  // ========================================================================
  // Campaign
  // ========================================================================

  /** Creates an evergreen campaign as a draft with no categories yet. The
   *  campaign-level schedule carries the shared timezone/blackout/loop
   *  settings; `weekdays`/`times` are always empty at this level since each
   *  category owns its own weekday/time schedule. */
  async createCampaign(
    workspaceId: string,
    userId: string,
    dto: CreateEvergreenCampaignDto,
  ): Promise<EvergreenCampaignDto> {
    const schedule: CampaignScheduleEvergreenJson = {
      type: 'evergreen',
      startDate: dto.startDate,
      weekdays: [],
      times: [],
      timezone: dto.timezone,
      blackoutDates: dto.blackoutDates ?? [],
      loop: dto.loop ?? true,
    };

    const [row] = await db
      .insert(campaigns)
      .values({
        workspaceId,
        createdById: userId,
        name: dto.name,
        description: dto.description?.trim() ? dto.description.trim() : null,
        type: 'evergreen',
        status: 'draft',
        schedule,
        contentSource: 'manual',
        aiConfig: null,
        libraryTemplateIds: [],
        channelIds: dto.channelIds,
        platforms: [],
      })
      .returning();

    return this.assembleEvergreen(row.id);
  }

  /** Scopes a campaign id to its workspace, 404ing otherwise. Returns the
   *  raw row (not the assembled DTO) since write methods only need it to
   *  validate ownership before touching category/post rows. */
  private async loadOwnedCampaign(workspaceId: string, campaignId: string): Promise<Campaign> {
    const [row] = await db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.workspaceId, workspaceId)));

    if (!row) {
      throw new NotFoundException('Campaign not found');
    }
    return row;
  }

  // ========================================================================
  // Categories
  // ========================================================================

  async addCategory(
    workspaceId: string,
    campaignId: string,
    dto: CreateEvergreenCategoryDto,
  ): Promise<EvergreenCampaignDto> {
    await this.loadOwnedCampaign(workspaceId, campaignId);

    await db.insert(evergreenCategories).values({
      campaignId,
      name: dto.name,
      color: dto.color,
      schedule: dto.schedule,
      channelIds: dto.channelIds,
      seasonal: dto.seasonal ?? null,
    });

    return this.assembleEvergreen(campaignId);
  }

  async updateCategory(
    workspaceId: string,
    campaignId: string,
    categoryId: string,
    dto: UpdateEvergreenCategoryDto,
  ): Promise<EvergreenCampaignDto> {
    await this.loadOwnedCampaign(workspaceId, campaignId);

    const [existing] = await db
      .select()
      .from(evergreenCategories)
      .where(
        and(eq(evergreenCategories.id, categoryId), eq(evergreenCategories.campaignId, campaignId)),
      );
    if (!existing) {
      throw new NotFoundException('Category not found');
    }

    const updates: Partial<EvergreenCategory> = { updatedAt: new Date() };
    if (dto.name !== undefined) updates.name = dto.name;
    if (dto.color !== undefined) updates.color = dto.color;
    if (dto.schedule !== undefined) updates.schedule = dto.schedule;
    if (dto.channelIds !== undefined) updates.channelIds = dto.channelIds;
    if (dto.seasonal !== undefined) updates.seasonal = dto.seasonal;

    await db.update(evergreenCategories).set(updates).where(eq(evergreenCategories.id, categoryId));

    return this.assembleEvergreen(campaignId);
  }

  async setCategoryActive(
    workspaceId: string,
    campaignId: string,
    categoryId: string,
    isActive: boolean,
  ): Promise<EvergreenCampaignDto> {
    await this.loadOwnedCampaign(workspaceId, campaignId);

    const [existing] = await db
      .select({ id: evergreenCategories.id })
      .from(evergreenCategories)
      .where(
        and(eq(evergreenCategories.id, categoryId), eq(evergreenCategories.campaignId, campaignId)),
      );
    if (!existing) {
      throw new NotFoundException('Category not found');
    }

    await db
      .update(evergreenCategories)
      .set({ isActive, updatedAt: new Date() })
      .where(eq(evergreenCategories.id, categoryId));

    return this.assembleEvergreen(campaignId);
  }

  /** Removes a category and cascades its pool posts. The schema's FK already
   *  carries `onDelete: 'cascade'`, but we delete posts explicitly first so
   *  the behaviour doesn't depend on cascade support in every environment
   *  (and so the fake-DB test harness can assert on it directly). */
  async removeCategory(
    workspaceId: string,
    campaignId: string,
    categoryId: string,
  ): Promise<EvergreenCampaignDto> {
    await this.loadOwnedCampaign(workspaceId, campaignId);

    await db.delete(evergreenPosts).where(eq(evergreenPosts.categoryId, categoryId));
    await db
      .delete(evergreenCategories)
      .where(
        and(eq(evergreenCategories.id, categoryId), eq(evergreenCategories.campaignId, campaignId)),
      );

    return this.assembleEvergreen(campaignId);
  }

  // ========================================================================
  // Pool posts
  // ========================================================================

  private async loadOwnedCategory(campaignId: string, categoryId: string): Promise<void> {
    const [existing] = await db
      .select({ id: evergreenCategories.id })
      .from(evergreenCategories)
      .where(
        and(eq(evergreenCategories.id, categoryId), eq(evergreenCategories.campaignId, campaignId)),
      );
    if (!existing) {
      throw new NotFoundException('Category not found');
    }
  }

  async addPost(
    workspaceId: string,
    campaignId: string,
    categoryId: string,
    dto: CreateEvergreenPostDto,
  ): Promise<EvergreenCampaignDto> {
    await this.loadOwnedCampaign(workspaceId, campaignId);
    await this.loadOwnedCategory(campaignId, categoryId);

    const recyclePolicy: RecyclePolicyJson = dto.recyclePolicy ?? { mode: 'forever' };

    await db.insert(evergreenPosts).values({
      campaignId,
      categoryId,
      content: dto.content,
      variations: [],
      recyclePolicy,
      minGapHours: dto.minGapHours ?? 0,
      status: 'active',
    });

    return this.assembleEvergreen(campaignId);
  }

  async updatePost(
    workspaceId: string,
    campaignId: string,
    categoryId: string,
    postId: string,
    dto: UpdateEvergreenPostDto,
  ): Promise<EvergreenCampaignDto> {
    await this.loadOwnedCampaign(workspaceId, campaignId);
    await this.loadOwnedCategory(campaignId, categoryId);

    const [existing] = await db
      .select({ id: evergreenPosts.id })
      .from(evergreenPosts)
      .where(and(eq(evergreenPosts.id, postId), eq(evergreenPosts.categoryId, categoryId)));
    if (!existing) {
      throw new NotFoundException('Post not found');
    }

    const updates: Partial<EvergreenPost> = { updatedAt: new Date() };
    if (dto.content !== undefined) updates.content = dto.content;
    if (dto.recyclePolicy !== undefined) updates.recyclePolicy = dto.recyclePolicy;
    if (dto.minGapHours !== undefined) updates.minGapHours = dto.minGapHours;

    await db.update(evergreenPosts).set(updates).where(eq(evergreenPosts.id, postId));

    return this.assembleEvergreen(campaignId);
  }

  async removePost(
    workspaceId: string,
    campaignId: string,
    categoryId: string,
    postId: string,
  ): Promise<EvergreenCampaignDto> {
    await this.loadOwnedCampaign(workspaceId, campaignId);
    await this.loadOwnedCategory(campaignId, categoryId);

    await db
      .delete(evergreenPosts)
      .where(and(eq(evergreenPosts.id, postId), eq(evergreenPosts.categoryId, categoryId)));

    return this.assembleEvergreen(campaignId);
  }
}
