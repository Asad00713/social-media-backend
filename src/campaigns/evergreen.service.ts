import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { db } from '../drizzle/db';
import {
  campaigns,
  type Campaign,
  type ChannelDayContentJson,
  type CampaignScheduleEvergreenJson,
} from '../drizzle/schema/campaigns.schema';
import { socialMediaChannels } from '../drizzle/schema/channels.schema';
import { posts } from '../drizzle/schema/posts.schema';
import {
  evergreenCategories,
  evergreenOccurrences,
  evergreenPosts,
  type EvergreenCategory,
  type EvergreenPost,
  type RecyclePolicyJson,
} from '../drizzle/schema/evergreen.schema';
import {
  computeNextCategoryFire,
  pickNextPost,
  selectVariation,
} from './evergreen-rotation.util';
import { CampaignPublishingService } from './campaign-publishing.service';
import { QUEUES } from '../queue/queue.module';
import { GroqService, type Platform } from '../ai/groq.service';
import { AiTokenService } from '../ai/services/ai-token.service';
import type {
  CreateEvergreenCampaignDto,
  CreateEvergreenCategoryDto,
  UpdateEvergreenCategoryDto,
  CreateEvergreenPostDto,
  UpdateEvergreenPostDto,
  AddVariationDto,
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

export interface EvergreenUpNextDto {
  occurrenceId: string;
  categoryId: string;
  scheduledAt: string;
  channelId: string;
  postIdRef: string;
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
  /** Next scheduled occurrences across all categories, soonest first. */
  upNext: EvergreenUpNextDto[];
}

/** How many upcoming occurrences `assembleEvergreen` surfaces in `upNext`. */
const UP_NEXT_LIMIT = 10;

@Injectable()
export class EvergreenService {
  private readonly logger = new Logger(EvergreenService.name);

  constructor(
    private readonly publishing: CampaignPublishingService,
    @InjectQueue(QUEUES.EVERGREEN_ROTATION)
    private readonly rotationQueue: Queue,
    private readonly groq: GroqService,
    private readonly aiTokens: AiTokenService,
  ) {}

  // ========================================================================
  // Assembly
  // ========================================================================

  /**
   * Loads a campaign row + its categories + each category's pool posts and
   * assembles the nested `EvergreenCampaignDto`, computing each category's
   * `nextRunAt` and the campaign's `upNext` (next scheduled occurrences
   * across all categories). Throws `NotFoundException` if the campaign id
   * doesn't exist.
   */
  async assembleEvergreen(campaignId: string): Promise<EvergreenCampaignDto> {
    const [row] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId));
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

    const upNext = await this.loadUpNext(row.id);

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
      libraryTemplateIds: row.libraryTemplateIds ?? [],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      launchedAt: row.launchedAt ? row.launchedAt.toISOString() : null,
      categories,
      upNext,
    };
  }

  /** Next `UP_NEXT_LIMIT` still-`scheduled`, not-yet-due-or-future occurrences
   *  across all of the campaign's categories, soonest first. Filtering to
   *  `scheduledAt >= now` and re-sorting client-side (rather than trusting
   *  DB order) keeps this correct against the fake-DB test harness, which
   *  doesn't implement `orderBy`/`gte` — and is cheap at this row count. */
  private async loadUpNext(campaignId: string): Promise<EvergreenUpNextDto[]> {
    const rows = await db
      .select()
      .from(evergreenOccurrences)
      .where(eq(evergreenOccurrences.campaignId, campaignId));

    const now = Date.now();
    return rows
      .filter(
        (r) => r.slotStatus === 'scheduled' && r.scheduledAt.getTime() >= now,
      )
      .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())
      .slice(0, UP_NEXT_LIMIT)
      .map((r) => ({
        occurrenceId: r.id,
        categoryId: r.categoryId,
        scheduledAt: r.scheduledAt.toISOString(),
        channelId: r.channelId,
        postIdRef: r.postIdRef,
      }));
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
      recyclePolicy: post.recyclePolicy,
      minGapHours: post.minGapHours,
      recycledCount: post.recycledCount,
      lastPublishedAt: post.lastPublishedAt
        ? post.lastPublishedAt.toISOString()
        : null,
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
  private async loadOwnedCampaign(
    workspaceId: string,
    campaignId: string,
  ): Promise<Campaign> {
    const [row] = await db
      .select()
      .from(campaigns)
      .where(
        and(
          eq(campaigns.id, campaignId),
          eq(campaigns.workspaceId, workspaceId),
        ),
      );

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
        and(
          eq(evergreenCategories.id, categoryId),
          eq(evergreenCategories.campaignId, campaignId),
        ),
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

    await db
      .update(evergreenCategories)
      .set(updates)
      .where(eq(evergreenCategories.id, categoryId));

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
        and(
          eq(evergreenCategories.id, categoryId),
          eq(evergreenCategories.campaignId, campaignId),
        ),
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

    await db
      .delete(evergreenPosts)
      .where(eq(evergreenPosts.categoryId, categoryId));
    await db
      .delete(evergreenCategories)
      .where(
        and(
          eq(evergreenCategories.id, categoryId),
          eq(evergreenCategories.campaignId, campaignId),
        ),
      );

    return this.assembleEvergreen(campaignId);
  }

  // ========================================================================
  // Pool posts
  // ========================================================================

  private async loadOwnedCategory(
    campaignId: string,
    categoryId: string,
  ): Promise<void> {
    const [existing] = await db
      .select({ id: evergreenCategories.id })
      .from(evergreenCategories)
      .where(
        and(
          eq(evergreenCategories.id, categoryId),
          eq(evergreenCategories.campaignId, campaignId),
        ),
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

    const recyclePolicy: RecyclePolicyJson = dto.recyclePolicy ?? {
      mode: 'forever',
    };

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
      .where(
        and(
          eq(evergreenPosts.id, postId),
          eq(evergreenPosts.categoryId, categoryId),
        ),
      );
    if (!existing) {
      throw new NotFoundException('Post not found');
    }

    const updates: Partial<EvergreenPost> = { updatedAt: new Date() };
    if (dto.content !== undefined) updates.content = dto.content;
    if (dto.recyclePolicy !== undefined)
      updates.recyclePolicy = dto.recyclePolicy;
    if (dto.minGapHours !== undefined) updates.minGapHours = dto.minGapHours;

    await db
      .update(evergreenPosts)
      .set(updates)
      .where(eq(evergreenPosts.id, postId));

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
      .where(
        and(
          eq(evergreenPosts.id, postId),
          eq(evergreenPosts.categoryId, categoryId),
        ),
      );

    return this.assembleEvergreen(campaignId);
  }

  /** Scopes a pool post id to its category (ownership-guarded like
   *  `updatePost`/`removePost` above), 404ing if it doesn't exist. Returns
   *  the raw row so callers can read `content.caption` / `variations`
   *  before deciding what to write. */
  private async loadOwnedPost(
    categoryId: string,
    postId: string,
  ): Promise<EvergreenPost> {
    const [existing] = await db
      .select()
      .from(evergreenPosts)
      .where(
        and(
          eq(evergreenPosts.id, postId),
          eq(evergreenPosts.categoryId, categoryId),
        ),
      );
    if (!existing) {
      throw new NotFoundException('Post not found');
    }
    return existing;
  }

  /**
   * Generates `count` AI variations of a pool post's base caption via
   * `GroqService.generateVariations`, metered through
   * `AiTokenService.executeWithTokens` (mirrors `ai.controller.ts`'s
   * wrapping — token-check, deduct-on-success, log-on-failure). Platform is
   * derived from the post's category's first configured channel (same
   * `socialMediaChannels` lookup `fireOccurrence` uses to resolve a
   * publish-time platform), falling back to the campaign's first
   * `platforms` entry if the category has no channels configured yet.
   *
   * GRACEFUL DEGRADATION: the Groq call + token metering happen BEFORE any
   * DB write. If either throws (Groq API failure, insufficient tokens,
   * `executeWithTokens`'s own token-check rejection), the exception
   * propagates to the caller untouched and this method returns without
   * touching `evergreenPosts.variations` at all — no partial write, no
   * corrupted array. The post is only persisted once generation has fully
   * succeeded and the new variation objects are assembled.
   */
  async generateVariations(
    workspaceId: string,
    userId: string,
    campaignId: string,
    categoryId: string,
    postId: string,
    count = 3,
  ): Promise<EvergreenCampaignDto> {
    await this.loadOwnedCampaign(workspaceId, campaignId);
    await this.loadOwnedCategory(campaignId, categoryId);
    const post = await this.loadOwnedPost(categoryId, postId);

    const platform = await this.resolvePlatform(categoryId, campaignId);
    const caption = post.content.caption;

    const { result: variationCaptions } = await this.aiTokens.executeWithTokens(
      workspaceId,
      userId,
      'generate_variations',
      platform,
      `Variations of: ${caption.substring(0, 100)}`,
      async () => {
        const variations = await this.groq.generateVariations(
          caption,
          platform as Platform,
          count,
        );
        return { result: variations, outputLength: variations.join('').length };
      },
    );

    // Only reachable once generation fully succeeded — assemble the new
    // variation objects and persist in one write, appended after whatever
    // already existed.
    const newVariations = variationCaptions.map((text) => ({
      id: randomUUID(),
      caption: text,
      source: 'ai' as const,
    }));

    await db
      .update(evergreenPosts)
      .set({
        variations: [...post.variations, ...newVariations],
        updatedAt: new Date(),
      })
      .where(eq(evergreenPosts.id, postId));

    return this.assembleEvergreen(campaignId);
  }

  /** Best-effort platform resolution for AI generation: the category's
   *  first configured channel's platform (same `socialMediaChannels`
   *  lookup `fireOccurrence` uses at publish time), falling back to the
   *  campaign's first `platforms` entry, then to `'facebook'` if neither is
   *  configured yet (a brand-new category/campaign with no channels
   *  attached — generation should still work, just without a
   *  platform-tuned prompt). */
  private async resolvePlatform(
    categoryId: string,
    campaignId: string,
  ): Promise<string> {
    const [category] = await db
      .select()
      .from(evergreenCategories)
      .where(eq(evergreenCategories.id, categoryId));
    const channelIds = (category?.channelIds as string[] | null) ?? [];

    if (channelIds.length > 0) {
      const [channelRow] = await db
        .select()
        .from(socialMediaChannels)
        .where(eq(socialMediaChannels.id, Number(channelIds[0])));
      if (channelRow) {
        return channelRow.platform;
      }
    }

    const [campaign] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId));
    const platforms = (campaign?.platforms as string[] | null) ?? [];
    return platforms[0] ?? 'facebook';
  }

  /** Appends a manually-authored variation (`source: 'manual'`) to the
   *  post's variations array. */
  async addVariation(
    workspaceId: string,
    campaignId: string,
    categoryId: string,
    postId: string,
    dto: AddVariationDto,
  ): Promise<EvergreenCampaignDto> {
    await this.loadOwnedCampaign(workspaceId, campaignId);
    await this.loadOwnedCategory(campaignId, categoryId);
    const post = await this.loadOwnedPost(categoryId, postId);

    const newVariation = {
      id: randomUUID(),
      caption: dto.caption,
      media: dto.media,
      source: 'manual' as const,
    };

    await db
      .update(evergreenPosts)
      .set({
        variations: [...post.variations, newVariation],
        updatedAt: new Date(),
      })
      .where(eq(evergreenPosts.id, postId));

    return this.assembleEvergreen(campaignId);
  }

  /** Removes one variation by id, leaving the rest untouched. */
  async removeVariation(
    workspaceId: string,
    campaignId: string,
    categoryId: string,
    postId: string,
    variationId: string,
  ): Promise<EvergreenCampaignDto> {
    await this.loadOwnedCampaign(workspaceId, campaignId);
    await this.loadOwnedCategory(campaignId, categoryId);
    const post = await this.loadOwnedPost(categoryId, postId);

    await db
      .update(evergreenPosts)
      .set({
        variations: post.variations.filter((v) => v.id !== variationId),
        updatedAt: new Date(),
      })
      .where(eq(evergreenPosts.id, postId));

    return this.assembleEvergreen(campaignId);
  }

  // ========================================================================
  // Rotation engine — per-fire re-enqueue chain (Task 6)
  //
  // Design choice (postIdRef arm-time-vs-fire-time): `evergreenOccurrences
  // .postIdRef` is NOT NULL (Task 1's schema), so an occurrence row cannot
  // exist without a post already chosen. We pick the post at ARM time via
  // `pickNextPost` and store it — this satisfies the FK immediately and lets
  // `assembleEvergreen`'s `upNext` show a concrete "what fires next" post
  // without waiting for fire time. At FIRE time we re-validate eligibility
  // (re-run `pickNextPost` against current state) rather than trusting the
  // stored pick blindly — a post can go stale/retired/exhaust its recycle
  // policy in the gap between arm and fire (the gap can be long: fires are
  // scheduled up to MAX_SCAN_DAYS out). If the stored post is no longer
  // eligible, we re-pick from the currently-eligible pool instead of
  // failing the fire.
  // ========================================================================

  /**
   * Computes the category's next fire instant and arms it: inserts ONE
   * `scheduled` `evergreenOccurrences` row PER `channelId` in the category's
   * `channelIds` (each its own occurrence → own post → own BullMQ job), all
   * at the SAME fire instant. The post to fire is picked ONCE via
   * `pickNextPost` and shared across every channel's occurrence for this
   * fire instant (rather than re-picked per channel) — simpler, and keeps
   * "what's firing right now" a single coherent answer across a category's
   * channels rather than a per-channel roulette. Each occurrence gets its
   * own deterministic `jobId = evg-<occurrenceId>`, so multiple channels
   * never collide on one BullMQ job id. Does nothing (just logs) when the
   * category has no weekdays/times configured (no next fire) or has no
   * channel/eligible post to arm against — the chain simply stays dormant
   * until the category is edited into a fireable state.
   */
  async armCategory(
    category: EvergreenCategory,
    campaign: Campaign,
    now: Date,
    excludeOccurrenceId?: string,
  ): Promise<void> {
    const schedule = campaign.schedule as CampaignScheduleEvergreenJson;

    const nextFire = computeNextCategoryFire(
      category.schedule,
      schedule.timezone,
      schedule.blackoutDates ?? [],
      now,
    );
    if (!nextFire) {
      this.logger.log(
        `armCategory(${category.id}): no next fire (no weekdays/times configured) — not arming.`,
      );
      return;
    }

    const channelIds = (category.channelIds as string[] | null) ?? [];
    if (channelIds.length === 0) {
      this.logger.warn(
        `armCategory(${category.id}): no channelIds configured — not arming.`,
      );
      return;
    }

    const postRows = await db
      .select()
      .from(evergreenPosts)
      .where(eq(evergreenPosts.categoryId, category.id));

    const picked = pickNextPost(postRows, category, now);
    if (!picked) {
      this.logger.log(
        `armCategory(${category.id}): no eligible post to arm — not arming.`,
      );
      return;
    }

    // Idempotency guard: skip any channel that already has a future
    // `scheduled` occurrence. Without this, calling `armCategory` again on a
    // category that's only PARTIALLY missing coverage (e.g. `reconcile`
    // finds channel B uncovered but channel A is still healthy) would insert
    // a SECOND live occurrence for channel A — a genuine duplicate/double-fire,
    // since each occurrence gets a fresh UUID and thus a distinct
    // deterministic jobId (the "deterministic jobId prevents double-fire"
    // guarantee only holds per-occurrence, not across re-arms). Filtering
    // here makes `armCategory` safe to call repeatedly against a category
    // that's already fully or partially armed — by `resume` after a
    // no-op-should-be pause, or by `reconcile`'s belt-and-suspenders sweep.
    // `excludeOccurrenceId` (set only by `fireOccurrence`'s re-arm-in-finally
    // call) excludes the occurrence currently being fired from this check —
    // it's still nominally `scheduled` in the DB if the fire threw before
    // reaching its own status-flip write, but it must NOT count as live
    // coverage for its own channel or the chain dies on the first failure.
    const existingOccurrences = await db
      .select()
      .from(evergreenOccurrences)
      .where(eq(evergreenOccurrences.categoryId, category.id));
    const coveredChannels = new Set(
      existingOccurrences
        .filter(
          (o) =>
            o.id !== excludeOccurrenceId &&
            o.slotStatus === 'scheduled' &&
            o.scheduledAt.getTime() >= now.getTime(),
        )
        .map((o) => o.channelId),
    );
    const channelsToArm = channelIds.filter((c) => !coveredChannels.has(c));

    if (channelsToArm.length === 0) {
      this.logger.log(
        `armCategory(${category.id}): every channel already has a future scheduled occurrence — nothing to arm.`,
      );
      return;
    }

    for (const channelId of channelsToArm) {
      const [occurrence] = await db
        .insert(evergreenOccurrences)
        .values({
          campaignId: category.campaignId,
          categoryId: category.id,
          postIdRef: picked.id,
          variationId: null,
          channelId,
          scheduledAt: nextFire,
          slotStatus: 'scheduled',
        })
        .returning();

      const jobId = `evg-${occurrence.id}`;
      const delay = Math.max(0, nextFire.getTime() - now.getTime());

      await this.rotationQueue.add(
        'evergreen-fire',
        { occurrenceId: occurrence.id },
        {
          delay,
          jobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        },
      );

      await db
        .update(evergreenOccurrences)
        .set({ jobId })
        .where(eq(evergreenOccurrences.id, occurrence.id));
    }
  }

  /**
   * Fires one occurrence: re-validates eligibility, publishes via
   * `CampaignPublishingService.materializeAndEnqueue`, bumps the post, and
   * ALWAYS arms the category's next fire in a `finally` block — even if the
   * publish call throws, or no post is eligible — so the rotation chain is
   * self-healing and never dies on a single bad fire.
   */
  async fireOccurrence(occurrenceId: string): Promise<void> {
    const [occurrence] = await db
      .select()
      .from(evergreenOccurrences)
      .where(eq(evergreenOccurrences.id, occurrenceId));
    if (!occurrence) {
      this.logger.warn(
        `fireOccurrence(${occurrenceId}): occurrence not found — nothing to do.`,
      );
      return;
    }

    const [category] = await db
      .select()
      .from(evergreenCategories)
      .where(eq(evergreenCategories.id, occurrence.categoryId));
    if (!category) {
      this.logger.warn(
        `fireOccurrence(${occurrenceId}): category ${occurrence.categoryId} not found — cannot fire or re-arm.`,
      );
      return;
    }

    const [campaign] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, occurrence.campaignId));
    if (!campaign) {
      this.logger.warn(
        `fireOccurrence(${occurrenceId}): campaign ${occurrence.campaignId} not found — cannot fire or re-arm.`,
      );
      return;
    }

    const now = new Date();

    try {
      // Idempotency guard (m1): a BullMQ retry (attempts:3) re-runs this
      // whole method from scratch. If a PRIOR attempt already got as far as
      // `materializeAndEnqueue` (postsRowId written) but threw before the
      // status-flip update below landed, re-materializing here would insert
      // a SECOND orphan `posts` row for the same occurrence. postsRowId
      // being set is proof the publish was already created, so treat this
      // as already-fired: skip straight to making the occurrence row
      // consistent (published) and fall through to the `finally` re-arm —
      // never call materializeAndEnqueue a second time for one occurrence.
      if (occurrence.postsRowId) {
        this.logger.warn(
          `fireOccurrence(${occurrenceId}): postsRowId already set (${occurrence.postsRowId}) — ` +
            'treating as already-fired (retry after a post-materialize crash), not re-materializing.',
        );
        await db
          .update(evergreenOccurrences)
          .set({
            slotStatus: 'published',
            publishedAt: occurrence.publishedAt ?? now,
          })
          .where(eq(evergreenOccurrences.id, occurrenceId));
        return;
      }

      const postRows = await db
        .select()
        .from(evergreenPosts)
        .where(eq(evergreenPosts.categoryId, category.id));

      // Re-validate at fire time — the arm-time pick may have gone stale
      // (retired, recycle policy exhausted, min-gap not yet satisfied vs. a
      // more recent fire, etc.) in the gap between arm and fire.
      const picked = pickNextPost(postRows, category, now);

      if (!picked) {
        await db
          .update(evergreenOccurrences)
          .set({
            slotStatus: 'skipped',
            lastError: 'No eligible post at fire time',
          })
          .where(eq(evergreenOccurrences.id, occurrenceId));
        return;
      }

      const variation = selectVariation(picked);

      const [channelRow] = await db
        .select()
        .from(socialMediaChannels)
        .where(eq(socialMediaChannels.id, Number(occurrence.channelId)));
      if (!channelRow) {
        await db
          .update(evergreenOccurrences)
          .set({ slotStatus: 'skipped', lastError: 'Channel unavailable' })
          .where(eq(evergreenOccurrences.id, occurrenceId));
        return;
      }

      const { date, time } = formatInTimeZone(
        occurrence.scheduledAt,
        (campaign.schedule as CampaignScheduleEvergreenJson).timezone,
      );

      const content: ChannelDayContentJson = {
        ...picked.content,
        caption: variation.caption,
      };

      const { postId, jobId } = await this.publishing.materializeAndEnqueue({
        workspaceId: campaign.workspaceId,
        createdById: campaign.createdById,
        campaignId: campaign.id,
        date,
        channelId: occurrence.channelId,
        time,
        content,
        platform: channelRow.platform,
        scheduledAt: now,
        destination: content.destination,
      });

      await db
        .update(evergreenOccurrences)
        .set({
          postIdRef: picked.id,
          variationId: variation.variationId,
          postsRowId: postId,
          jobId,
          slotStatus: 'published',
          publishedAt: now,
        })
        .where(eq(evergreenOccurrences.id, occurrenceId));

      await db
        .update(evergreenPosts)
        .set({
          recycledCount: picked.recycledCount + 1,
          lastPublishedAt: now,
          updatedAt: now,
        })
        .where(eq(evergreenPosts.id, picked.id));
    } finally {
      if (category.isActive) {
        // Exclude this occurrence from armCategory's own-channel coverage
        // check — on the success paths above its slotStatus already flipped
        // away from 'scheduled' (published/skipped) so this is only load-
        // bearing on the exception path, where the status-flip write never
        // ran and the row is still nominally 'scheduled'.
        await this.armCategory(category, campaign, now, occurrenceId);
      } else {
        this.logger.log(
          `fireOccurrence(${occurrenceId}): category is inactive — not re-arming.`,
        );
      }
    }
  }

  // ========================================================================
  // Lifecycle — launch / pause / resume / reconcile
  //
  // Delegated into from `CampaignsService` when `campaign.type ===
  // 'evergreen'` (one-directional dependency: THIS service never imports or
  // injects `CampaignsService`, so there's no circular-dep risk — see
  // task-7-brief's CIRCULAR-DEP ruling).
  // ========================================================================

  /** True when at least one pool post under `categoryId` is eligible to fire
   *  right now against `category`. Used by `launch`'s preflight (does ANY
   *  active category have publishable content) without needing to actually
   *  arm anything yet. */
  private async categoryHasEligiblePost(
    category: EvergreenCategory,
    now: Date,
  ): Promise<boolean> {
    const postRows = await db
      .select()
      .from(evergreenPosts)
      .where(eq(evergreenPosts.categoryId, category.id));
    return pickNextPost(postRows, category, now) !== null;
  }

  /**
   * Validates the campaign has at least one active category with at least
   * one eligible pool post (mirrors `CampaignsService.launch`'s preflight —
   * throws a clear `BadRequestException` rather than silently launching an
   * empty campaign), arms (fan-out) every active category, then flips the
   * campaign to `active` with `launchedAt` set. A category that individually
   * has zero eligible posts is simply skipped by `armCategory` (it no-ops
   * and logs) — the launch as a whole still succeeds as long as AT LEAST ONE
   * active category could arm.
   */
  async launch(workspaceId: string, id: string): Promise<EvergreenCampaignDto> {
    const campaign = await this.loadOwnedCampaign(workspaceId, id);

    const categoryRows = await db
      .select()
      .from(evergreenCategories)
      .where(eq(evergreenCategories.campaignId, id));

    const activeCategories = categoryRows.filter((c) => c.isActive);
    const now = new Date();

    const eligibleFlags = await Promise.all(
      activeCategories.map((c) => this.categoryHasEligiblePost(c, now)),
    );
    const hasAnyEligible = eligibleFlags.some(Boolean);

    if (activeCategories.length === 0 || !hasAnyEligible) {
      throw new BadRequestException(
        'This campaign has no publishable content. Add at least one active category with an eligible post before launching.',
      );
    }

    for (const category of activeCategories) {
      await this.armCategory(category, campaign, now);
    }

    await db
      .update(campaigns)
      .set({ status: 'active', launchedAt: now, updatedAt: now })
      .where(eq(campaigns.id, id));

    return this.assembleEvergreen(id);
  }

  /**
   * Pulls back every future `scheduled` occurrence: cancels its enqueued
   * BullMQ job and deletes its not-yet-published `posts` row (guarded on
   * `posts.status = 'scheduled'`, same race-safety pattern as
   * `CampaignsService.cancelAndClearSlotPost` — a post that's already
   * flipped to `publishing` is left alone rather than yanked mid-flight),
   * then removes the occurrence row itself so `reconcile`/`resume` see a
   * clean slate to re-arm from. Already-`published`/`skipped` occurrences
   * are left untouched — pause only pulls back work that hasn't fired yet.
   * The pool + categories themselves are untouched; only in-flight
   * scheduling state is torn down.
   */
  async pause(workspaceId: string, id: string): Promise<EvergreenCampaignDto> {
    await this.loadOwnedCampaign(workspaceId, id);

    const occurrenceRows = await db
      .select()
      .from(evergreenOccurrences)
      .where(eq(evergreenOccurrences.campaignId, id));

    const now = Date.now();
    const futureScheduled = occurrenceRows.filter(
      (o) => o.slotStatus === 'scheduled' && o.scheduledAt.getTime() >= now,
    );

    for (const occurrence of futureScheduled) {
      if (occurrence.jobId) {
        await this.publishing.cancelSlotJob(occurrence.jobId);
      }
      if (occurrence.postsRowId) {
        await db
          .delete(posts)
          .where(
            and(
              eq(posts.id, occurrence.postsRowId),
              eq(posts.status, 'scheduled'),
            ),
          );
      }
      await db
        .delete(evergreenOccurrences)
        .where(eq(evergreenOccurrences.id, occurrence.id));
    }

    await db
      .update(campaigns)
      .set({ status: 'paused', updatedAt: new Date() })
      .where(eq(campaigns.id, id));

    return this.assembleEvergreen(id);
  }

  /**
   * Re-arms (fan-out) every active category and flips the campaign back to
   * `active`. Mirrors `launch` minus the preflight validation — a campaign
   * that was launched once already proved it has publishable content, and a
   * category with zero eligible posts today simply arms nothing (same
   * graceful no-op `armCategory` already applies elsewhere) rather than
   * blocking the resume.
   */
  async resume(workspaceId: string, id: string): Promise<EvergreenCampaignDto> {
    const campaign = await this.loadOwnedCampaign(workspaceId, id);

    const categoryRows = await db
      .select()
      .from(evergreenCategories)
      .where(eq(evergreenCategories.campaignId, id));

    const now = new Date();
    for (const category of categoryRows.filter((c) => c.isActive)) {
      await this.armCategory(category, campaign, now);
    }

    await db
      .update(campaigns)
      .set({ status: 'active', updatedAt: now })
      .where(eq(campaigns.id, id));

    return this.assembleEvergreen(id);
  }

  /**
   * Belt-and-suspenders sweep against a dead rotation chain: for every
   * ACTIVE evergreen campaign's ACTIVE category, checks each configured
   * channel individually — if that channel has no future `scheduled`
   * occurrence, re-arms the category (fan-out inserts one occurrence PER
   * channel, so a channel that's already covered doesn't need re-arming;
   * only the campaign-wide gap matters). Idempotent: `armCategory`'s
   * deterministic `jobId = evg-<occurrenceId>` means even if this runs
   * against a chain that's actually still healthy, no double-fire can occur
   * — BullMQ rejects/no-ops a duplicate job id, and each occurrence row is
   * freshly inserted so there's no update collision either. Intended to run
   * on a daily cron (`EvergreenReconcileCron`); safe to call ad hoc too.
   */
  async reconcile(): Promise<void> {
    const activeCampaigns = (
      await db.select().from(campaigns)
    ).filter((c) => c.type === 'evergreen' && c.status === 'active');

    const now = new Date();

    for (const campaign of activeCampaigns) {
      const categoryRows = await db
        .select()
        .from(evergreenCategories)
        .where(eq(evergreenCategories.campaignId, campaign.id));

      for (const category of categoryRows.filter((c) => c.isActive)) {
        const channelIds = (category.channelIds as string[] | null) ?? [];
        if (channelIds.length === 0) continue;

        const occurrenceRows = await db
          .select()
          .from(evergreenOccurrences)
          .where(eq(evergreenOccurrences.categoryId, category.id));

        const coveredChannels = new Set(
          occurrenceRows
            .filter(
              (o) =>
                o.slotStatus === 'scheduled' &&
                o.scheduledAt.getTime() >= now.getTime(),
            )
            .map((o) => o.channelId),
        );

        const missingAChannel = channelIds.some(
          (channelId) => !coveredChannels.has(channelId),
        );

        if (missingAChannel) {
          this.logger.log(
            `reconcile(): category ${category.id} has a channel with no future scheduled occurrence — re-arming.`,
          );
          await this.armCategory(category, campaign, now);
        }
      }
    }
  }
}

// ==========================================================================
// Timezone formatting helper
// ==========================================================================

/** Format a UTC instant as wall-clock `{ date: yyyy-MM-dd, time: HH:mm }` in
 *  `timeZone`, using the same `Intl.DateTimeFormat` trick as the rotation
 *  util's `zoneOffsetMinutes` (kept local/simple rather than importing a
 *  private helper). Falls back gracefully to UTC formatting if `timeZone`
 *  is invalid. */
function formatInTimeZone(
  at: Date,
  timeZone: string,
): { date: string; time: string } {
  let dtf: Intl.DateTimeFormat;
  try {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  const parts = dtf.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
}
