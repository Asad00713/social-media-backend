import { Injectable, Logger, NotFoundException } from '@nestjs/common';
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
   * Computes the category's next fire instant and arms it: inserts a
   * `scheduled` `evergreenOccurrences` row (picking the post to fire via
   * `pickNextPost`, and a channel from the category's `channelIds`) and
   * enqueues a delayed `evergreen-rotation` job `{ occurrenceId }` with a
   * deterministic `jobId = evg-<occurrenceId>`. Does nothing (just logs) when
   * the category has no weekdays/times configured (no next fire) or has no
   * channel/eligible post to arm against — the chain simply stays dormant
   * until the category is edited into a fireable state.
   */
  async armCategory(
    category: EvergreenCategory,
    campaign: Campaign,
    now: Date,
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
    const channelId = channelIds[0];
    if (!channelId) {
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
        await this.armCategory(category, campaign, now);
      } else {
        this.logger.log(
          `fireOccurrence(${occurrenceId}): category is inactive — not re-arming.`,
        );
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
