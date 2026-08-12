import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../drizzle/db';
import {
  campaigns,
  campaignDays,
  campaignSlotContent,
  CAMPAIGN_STATUSES,
  type Campaign,
  type CampaignDay,
  type CampaignSlotContent,
  type CampaignScheduleJson,
  type ChannelDayContentJson,
} from '../drizzle/schema/campaigns.schema';
import { socialMediaChannels } from '../drizzle/schema/channels.schema';
import { computeSlotSchedule } from './campaign-schedule.util';
import { CampaignPublishingService } from './campaign-publishing.service';

// ==========================================================================
// Response DTO — mirrors the frontend `Campaign` shape byte-for-byte so the
// API round-trips without translation. See socialmedia-frontend
// `src/features/campaigns/types/campaign.ts`.
// ==========================================================================

export interface CampaignDaySlotDto {
  channelContent: Record<string, ChannelDayContentJson>;
  skip?: boolean;
}

export type CampaignSlotContentDto = Record<string, CampaignDaySlotDto>;

export interface CampaignMetricsDto {
  postsPlanned: number;
  postsPublished: number;
  postsFailed: number;
  postsSkipped: number;
}

export interface CampaignDto {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  type: string;
  status: string;
  channelIds: string[];
  platforms: string[];
  schedule: CampaignScheduleJson;
  contentSource: string;
  aiConfig: Record<string, unknown> | null;
  libraryTemplateIds: string[];
  slotContent: CampaignSlotContentDto;
  metrics: CampaignMetricsDto;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
}

export interface CampaignListFilters {
  status?: string;
  search?: string;
}

export type CampaignStatusCounts = Record<
  'all' | 'draft' | 'scheduled' | 'active' | 'paused' | 'completed' | 'failed',
  number
>;

// ==========================================================================
// Write DTOs — mirror the frontend mock store's input shapes
// (campaigns-mock-store.ts: CreateSimpleCampaignInput / UpdateCampaignPatch).
// ==========================================================================

export interface CreateSimpleCampaignDto {
  name: string;
  description?: string;
  startDate: string; // yyyy-MM-dd
  endDate: string; // yyyy-MM-dd
  timezone: string;
  defaultTime: string; // HH:mm
  skipWeekends: boolean;
}

/** Fields the builder can patch on the campaign itself (not slot content). */
export interface UpdateCampaignDto {
  name?: string;
  description?: string | null;
  channelIds?: string[];
  platforms?: string[];
  contentSource?: string;
  aiConfig?: Record<string, unknown> | null;
  scheduleDefaultTime?: string;
  skipWeekends?: boolean;
  blackoutDates?: string[];
}

export interface AddEventDto {
  date: string;
  channelId: string;
  postType?: string;
  platform?: string;
}

export interface UpdateEventDto {
  date: string;
  channelId: string;
  patch: Partial<ChannelDayContentJson>;
}

export interface RemoveEventDto {
  date: string;
  channelId: string;
}

/** Loose shape of the frontend `AiAutopilotConfig` — enough to reproduce
 *  `mockAiCaption` server-side. Kept loose (matches `campaigns.aiConfig`
 *  column typing) since the full shape lives in the frontend only. */
interface AiAutopilotConfigJson {
  brief?: string;
  tone?: string[];
  approvalMode?: 'auto' | 'preview';
  guardrails?: {
    mustIncludeCta?: boolean;
  };
}

const ACTIVE_NEXT_RUN_STATUSES = new Set(['active', 'scheduled']);

// Hard stop for the day-by-day scan in computeNextRun so a malformed
// schedule (e.g. end < start) can never loop indefinitely.
const MAX_NEXT_RUN_SCAN_DAYS = 3660; // ~10 years

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(private readonly publishing: CampaignPublishingService) {}

  // ==========================================================================
  // Pure helpers — no DB access. Exported as instance methods so they're
  // directly unit-testable and reusable by the write half (Task 3/4).
  // ==========================================================================

  /**
   * Port of the frontend `isChannelDayFilled` (slot-content.ts). AI mode
   * always counts as filled (it generates at runtime); library mode needs at
   * least one assigned template; poll needs a non-blank question; thread
   * needs a non-blank caption (media does not count for threads); every
   * other manual post type is filled by a non-blank caption OR any media.
   */
  isSlotFilled(content: ChannelDayContentJson | undefined): boolean {
    if (!content) return false;
    if (content.mode === 'ai') return true;
    if (content.mode === 'library') return content.templateIds.length > 0;

    if (content.postType === 'poll') {
      return !!content.poll && content.poll.question.trim().length > 0;
    }
    if (content.postType === 'thread') {
      return content.caption.trim().length > 0;
    }
    if (content.caption.trim().length > 0) return true;
    if (content.media.length > 0) return true;
    return false;
  }

  /**
   * postsPlanned = count of filled slots whose date is a non-skipped day.
   * A date with no matching `campaignDays` row is treated as non-skipped
   * (skip defaults to false). published/failed/skipped are always 0 in
   * Phase 1 — nothing actually publishes yet, so there is no real counter
   * to report (avoids drift between a stored count and reality).
   */
  computeMetrics(
    days: Pick<CampaignDay, 'date' | 'skip'>[],
    slots: Pick<CampaignSlotContent, 'date' | 'content'>[],
  ): CampaignMetricsDto {
    const skippedDates = new Set(
      days.filter((d) => d.skip).map((d) => d.date),
    );

    let postsPlanned = 0;
    for (const slot of slots) {
      if (skippedDates.has(slot.date)) continue;
      if (this.isSlotFilled(slot.content)) postsPlanned += 1;
    }

    return {
      postsPlanned,
      postsPublished: 0,
      postsFailed: 0,
      postsSkipped: 0,
    };
  }

  /**
   * Display-only next-firing computation. Returns null for any status other
   * than 'active'/'scheduled', or when no future firing exists within the
   * schedule's start–end window. Not a real job trigger — Phase 2's
   * scheduler supersedes this.
   */
  computeNextRun(
    schedule: CampaignScheduleJson,
    status: string,
  ): string | null {
    // TODO(phase-2): honor schedule.timezone — currently uses server-local
    // time; correct only on a UTC server. Display-only in Phase 1.
    if (!ACTIVE_NEXT_RUN_STATUSES.has(status)) return null;

    const now = new Date();
    const blackout = new Set(schedule.blackoutDates ?? []);

    if (schedule.type === 'bulk') {
      const time = schedule.perDayTimes ?? {};
      return this.scanDailyWindow({
        startDate: schedule.startDate,
        endDate: schedule.endDate,
        now,
        blackout,
        skipWeekends: schedule.skipWeekends,
        timeFor: (date) => time[date] ?? schedule.defaultTime,
      });
    }

    // drip / evergreen share the weekday+times model.
    const weekdays = new Set(schedule.weekdays ?? []);
    const times = [...(schedule.times ?? [])].sort();
    if (weekdays.size === 0 || times.length === 0) return null;

    const endDate = schedule.type === 'drip' ? schedule.endDate : null;

    return this.scanWeekdayWindow({
      startDate: schedule.startDate,
      endDate,
      now,
      blackout,
      weekdays,
      times,
    });
  }

  private scanDailyWindow(params: {
    startDate: string;
    endDate: string;
    now: Date;
    blackout: Set<string>;
    skipWeekends: boolean;
    timeFor: (date: string) => string;
  }): string | null {
    const { startDate, endDate, now, blackout, skipWeekends, timeFor } =
      params;

    let cursor = this.parseIsoDate(startDate);
    const end = this.parseIsoDate(endDate);
    if (!cursor || !end) return null;

    for (let i = 0; i < MAX_NEXT_RUN_SCAN_DAYS && cursor <= end; i += 1) {
      const iso = this.toIsoDate(cursor);
      const isWeekend = cursor.getDay() === 0 || cursor.getDay() === 6;

      if (!blackout.has(iso) && !(skipWeekends && isWeekend)) {
        const candidate = this.combineDateTime(iso, timeFor(iso));
        if (candidate && candidate.getTime() >= now.getTime()) {
          return candidate.toISOString();
        }
      }

      cursor = this.addDays(cursor, 1);
    }

    return null;
  }

  private scanWeekdayWindow(params: {
    startDate: string;
    endDate: string | null;
    now: Date;
    blackout: Set<string>;
    weekdays: Set<number>;
    times: string[];
  }): string | null {
    const { startDate, endDate, now, blackout, weekdays, times } = params;

    let cursor = this.parseIsoDate(startDate);
    if (!cursor) return null;
    const end = endDate ? this.parseIsoDate(endDate) : null;

    // If start is in the past, begin scanning from today so we don't waste
    // the whole loop budget walking through history for long-running drips.
    const today = this.parseIsoDate(this.toIsoDate(now));
    if (today && cursor < today) cursor = today;

    for (
      let i = 0;
      i < MAX_NEXT_RUN_SCAN_DAYS && (!end || cursor <= end);
      i += 1
    ) {
      const iso = this.toIsoDate(cursor);

      if (weekdays.has(cursor.getDay()) && !blackout.has(iso)) {
        for (const time of times) {
          const candidate = this.combineDateTime(iso, time);
          if (candidate && candidate.getTime() >= now.getTime()) {
            return candidate.toISOString();
          }
        }
      }

      cursor = this.addDays(cursor, 1);
    }

    return null;
  }

  private parseIsoDate(iso: string | null | undefined): Date | null {
    if (!iso) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!match) return null;
    const [, y, m, d] = match;
    return new Date(Number(y), Number(m) - 1, Number(d));
  }

  private toIsoDate(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;
  }

  private addDays(d: Date, days: number): Date {
    const next = new Date(d);
    next.setDate(next.getDate() + days);
    return next;
  }

  private combineDateTime(iso: string, time: string): Date | null {
    const match = /^(\d{2}):(\d{2})$/.exec(time ?? '');
    if (!match) return null;
    const [, hh, mm] = match;
    const base = this.parseIsoDate(iso);
    if (!base) return null;
    base.setHours(Number(hh), Number(mm), 0, 0);
    return base;
  }

  /**
   * Port of the frontend `emptyChannelDayContent` (slot-content.ts). Builds a
   * blank slot payload for a freshly-added channel-day.
   */
  emptyChannelDayContent(
    postType: string,
    mode: string = 'manual',
  ): ChannelDayContentJson {
    return {
      mode: mode as ChannelDayContentJson['mode'],
      postType,
      caption: '',
      media: [],
      threadParts: [],
      templateIds: [],
      poll:
        postType === 'poll'
          ? { question: '', options: ['', ''], durationDays: 1 }
          : undefined,
    };
  }

  /**
   * Port of the frontend `mockAiCaption` (campaigns-mock-store.ts). Builds a
   * mock-realistic AI caption from the campaign's Autopilot config.
   */
  mockAiCaption(
    date: string,
    aiConfig: AiAutopilotConfigJson | null | undefined,
  ): string {
    const brief = aiConfig?.brief?.trim() ? aiConfig.brief.trim() : 'your campaign';
    const toneHint = aiConfig?.tone?.length
      ? ` in a ${aiConfig.tone.join(', ')} tone`
      : '';
    const cta = aiConfig?.guardrails?.mustIncludeCta
      ? ' Learn more — link in bio!'
      : '';
    return `AI draft for ${date} — ${brief}${toneHint} ✨${cta}`;
  }

  /**
   * Union of `channelId` across a set of slot rows — the pure core of
   * `refreshChannelCache`, extracted so it's directly unit-testable without a
   * DB.
   */
  computeChannelIdUnion(slots: Pick<CampaignSlotContent, 'channelId'>[]): string[] {
    return [...new Set(slots.map((s) => s.channelId))];
  }

  // ==========================================================================
  // Assembly
  // ==========================================================================

  /**
   * Loads a campaign row + its days + slots and assembles the nested
   * frontend `Campaign` shape, with computed `metrics` and `nextRunAt`.
   * Does NOT scope by workspace — callers that need workspace-scoping
   * (`getOne`) verify `workspaceId` before calling. Throws `NotFoundException`
   * if the id doesn't exist at all (used by Task 3/4 write flows immediately
   * after an insert/update, where the row is expected to exist).
   */
  async assembleCampaign(campaignId: string): Promise<CampaignDto> {
    const [row] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId));

    if (!row) {
      throw new NotFoundException('Campaign not found');
    }

    return this.assembleFromRow(row);
  }

  private async assembleFromRow(row: Campaign): Promise<CampaignDto> {
    const [days, slots] = await Promise.all([
      db.select().from(campaignDays).where(eq(campaignDays.campaignId, row.id)),
      db
        .select()
        .from(campaignSlotContent)
        .where(eq(campaignSlotContent.campaignId, row.id)),
    ]);

    return this.toDto(row, days, slots);
  }

  private toDto(
    row: Campaign,
    days: CampaignDay[],
    slots: CampaignSlotContent[],
  ): CampaignDto {
    const slotContent: CampaignSlotContentDto = {};

    // Seed every known day (even with zero slots) so `skip` is represented.
    for (const day of days) {
      slotContent[day.date] = {
        channelContent: slotContent[day.date]?.channelContent ?? {},
        skip: day.skip,
      };
    }

    for (const slot of slots) {
      const existing = slotContent[slot.date] ?? { channelContent: {} };
      existing.channelContent[slot.channelId] = slot.content;
      slotContent[slot.date] = existing;
    }

    const metrics = this.computeMetrics(days, slots);
    const nextRunAt = this.computeNextRun(row.schedule, row.status);

    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      description: row.description,
      type: row.type,
      status: row.status,
      channelIds: (row.channelIds as string[] | null) ?? [],
      platforms: (row.platforms as string[] | null) ?? [],
      schedule: row.schedule,
      contentSource: row.contentSource,
      aiConfig: row.aiConfig,
      libraryTemplateIds: (row.libraryTemplateIds as string[] | null) ?? [],
      slotContent,
      metrics,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      nextRunAt,
    };
  }

  // ==========================================================================
  // Read methods
  // ==========================================================================

  async list(
    workspaceId: string,
    filters: CampaignListFilters = {},
  ): Promise<CampaignDto[]> {
    const conditions = [eq(campaigns.workspaceId, workspaceId)];
    if (filters.status) {
      conditions.push(eq(campaigns.status, filters.status));
    }

    const rows = await db
      .select()
      .from(campaigns)
      .where(and(...conditions))
      .orderBy(desc(campaigns.createdAt));

    const filteredRows = filters.search
      ? rows.filter((r) => {
          const q = filters.search!.toLowerCase().trim();
          return (
            r.name.toLowerCase().includes(q) ||
            (r.description ?? '').toLowerCase().includes(q)
          );
        })
      : rows;

    if (filteredRows.length === 0) return [];

    const campaignIds = filteredRows.map((r) => r.id);

    const [days, slots] = await Promise.all([
      db
        .select()
        .from(campaignDays)
        .where(inArray(campaignDays.campaignId, campaignIds)),
      db
        .select()
        .from(campaignSlotContent)
        .where(inArray(campaignSlotContent.campaignId, campaignIds)),
    ]);

    const daysByCampaign = this.groupBy(days, (d) => d.campaignId);
    const slotsByCampaign = this.groupBy(slots, (s) => s.campaignId);

    return filteredRows.map((row) =>
      this.toDto(
        row,
        daysByCampaign.get(row.id) ?? [],
        slotsByCampaign.get(row.id) ?? [],
      ),
    );
  }

  async getOne(workspaceId: string, id: string): Promise<CampaignDto> {
    const [row] = await db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, id), eq(campaigns.workspaceId, workspaceId)));

    if (!row) {
      throw new NotFoundException('Campaign not found');
    }

    return this.assembleFromRow(row);
  }

  async statusCounts(workspaceId: string): Promise<CampaignStatusCounts> {
    const rows = await db
      .select({ status: campaigns.status })
      .from(campaigns)
      .where(eq(campaigns.workspaceId, workspaceId));

    const counts: CampaignStatusCounts = {
      all: rows.length,
      draft: 0,
      scheduled: 0,
      active: 0,
      paused: 0,
      completed: 0,
      failed: 0,
    };

    for (const row of rows) {
      if ((CAMPAIGN_STATUSES as readonly string[]).includes(row.status)) {
        counts[row.status as keyof CampaignStatusCounts] += 1;
      }
    }

    return counts;
  }

  // ==========================================================================
  // Write methods — CRUD, lifecycle, days & slots.
  //
  // Every method here re-derives a fresh `CampaignDto` via `assembleCampaign`
  // after mutating, mirroring the frontend mock store's `return
  // delay(snapshot(c))` pattern. Every method that isn't a bare insert first
  // scopes to `workspaceId` via `getOne` (throws 404 if the campaign doesn't
  // belong to the workspace) before touching any row.
  // ==========================================================================

  /** Creates a Simple (type `'bulk'`) campaign as a draft with no content
   *  yet. Port of the mock store's `createSimpleCampaign`. */
  async createSimple(
    workspaceId: string,
    userId: string,
    dto: CreateSimpleCampaignDto,
  ): Promise<CampaignDto> {
    const schedule: CampaignScheduleJson = {
      type: 'bulk',
      startDate: dto.startDate,
      endDate: dto.endDate,
      defaultTime: dto.defaultTime,
      timezone: dto.timezone,
      blackoutDates: [],
      skipWeekends: dto.skipWeekends,
    };

    const [row] = await db
      .insert(campaigns)
      .values({
        workspaceId,
        createdById: userId,
        name: dto.name,
        description: dto.description?.trim() ? dto.description.trim() : null,
        type: 'bulk',
        status: 'draft',
        schedule,
        contentSource: 'manual',
        aiConfig: null,
        libraryTemplateIds: [],
        channelIds: [],
        platforms: [],
      })
      .returning();

    return this.assembleCampaign(row.id);
  }

  /**
   * Patches name/description/contentSource/aiConfig + bulk-schedule fields
   * (defaultTime/skipWeekends/blackoutDates). `channelIds`/`platforms` in the
   * DTO are accepted but ignored — they're always recomputed by
   * `refreshChannelCache` on the next slot change, same as the mock store
   * (which only writes them from `addEvent`, never from `updateCampaign`
   * directly — the patch fields exist on the type but the caller-facing
   * builder never sends them for a live campaign).
   */
  async update(
    workspaceId: string,
    id: string,
    patch: UpdateCampaignDto,
  ): Promise<CampaignDto> {
    const existing = await this.getOne(workspaceId, id);

    const updates: Partial<Campaign> = {
      updatedAt: new Date(),
    };
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.description !== undefined) updates.description = patch.description;
    if (patch.contentSource !== undefined) updates.contentSource = patch.contentSource;
    if (patch.aiConfig !== undefined) updates.aiConfig = patch.aiConfig;

    if (existing.schedule.type === 'bulk') {
      const schedule: CampaignScheduleJson = { ...existing.schedule };
      if (patch.scheduleDefaultTime !== undefined) {
        schedule.defaultTime = patch.scheduleDefaultTime;
      }
      if (patch.skipWeekends !== undefined) {
        schedule.skipWeekends = patch.skipWeekends;
      }
      if (patch.blackoutDates !== undefined) {
        schedule.blackoutDates = patch.blackoutDates;
      }
      updates.schedule = schedule;
    }

    await db.update(campaigns).set(updates).where(eq(campaigns.id, id));

    return this.assembleCampaign(id);
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    await this.getOne(workspaceId, id);
    await db.delete(campaigns).where(eq(campaigns.id, id));
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  private async setStatus(
    workspaceId: string,
    id: string,
    status: string,
  ): Promise<CampaignDto> {
    await this.getOne(workspaceId, id);
    await db
      .update(campaigns)
      .set({ status, updatedAt: new Date() })
      .where(eq(campaigns.id, id));
    return this.assembleCampaign(id);
  }

  /**
   * Loads a campaign's raw `createdById` column — not exposed on the public
   * `CampaignDto` (see Task 4 note). Used by `launch` (and reused by
   * `pause`/`resume`/rescheduling flows) whenever the write path needs the
   * original creator rather than the DTO's caller-facing shape.
   */
  private async loadCreatedById(id: string): Promise<string> {
    const [row] = await db
      .select({ createdById: campaigns.createdById })
      .from(campaigns)
      .where(eq(campaigns.id, id));

    if (!row) {
      throw new NotFoundException('Campaign not found');
    }

    return row.createdById;
  }

  /** Publishable = slot is filled, its day is not skipped, and if AI-mode its
   *  aiSubState is 'approved'. Returns slot id/date/channelId/content. */
  private async collectPublishableSlots(campaignId: string): Promise<
    { slotId: string; date: string; channelId: string; content: ChannelDayContentJson }[]
  > {
    const [days, slots] = await Promise.all([
      db.select().from(campaignDays).where(eq(campaignDays.campaignId, campaignId)),
      db
        .select()
        .from(campaignSlotContent)
        .where(eq(campaignSlotContent.campaignId, campaignId)),
    ]);
    const skipped = new Set(days.filter((d) => d.skip).map((d) => d.date));
    return slots
      .filter((s) => !skipped.has(s.date))
      .filter((s) => this.isSlotFilled(s.content))
      .filter((s) => s.content.mode !== 'ai' || s.content.aiSubState === 'approved')
      .map((s) => ({ slotId: s.id, date: s.date, channelId: s.channelId, content: s.content }));
  }

  /** channelId (stringified numeric) → platform. Missing/deleted channels are
   *  absent from the map, so the caller skips them. */
  private async resolveSlotChannels(channelIds: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(channelIds)];
    const numericIds = unique.map((c) => Number(c)).filter((n) => Number.isFinite(n));
    if (numericIds.length === 0) return new Map();
    const rows = await db
      .select({ id: socialMediaChannels.id, platform: socialMediaChannels.platform })
      .from(socialMediaChannels)
      .where(inArray(socialMediaChannels.id, numericIds));
    return new Map(rows.map((r) => [String(r.id), r.platform]));
  }

  /**
   * Preflights the campaign for publishable content, resolves each slot's
   * channel to a platform, computes the due schedule per date (Task 2), then
   * materializes + enqueues each due slot as a real post (Task 3). Past-due
   * or excluded (blackout/weekend) dates and slots whose channel no longer
   * resolves are marked `skipped` rather than blocking the whole launch.
   * Sets the campaign to `active` with `launchedAt` once all slots are
   * processed.
   */
  async launch(workspaceId: string, id: string): Promise<CampaignDto> {
    const campaign = await this.getOne(workspaceId, id); // 404 if wrong workspace

    // Preflight: gather publishable slots (filled + day not skipped + AI approved).
    const publishable = await this.collectPublishableSlots(id);
    if (publishable.length === 0) {
      throw new BadRequestException(
        'This campaign has no publishable content. Add at least one filled post before launching.',
      );
    }

    const createdById = await this.loadCreatedById(id);

    // Resolve platform per channel; reject if a referenced channel is gone.
    const channelMap = await this.resolveSlotChannels(
      publishable.map((s) => s.channelId),
    );

    const dates = [...new Set(publishable.map((s) => s.date))];
    const { due, pastDue } = computeSlotSchedule(campaign.schedule, dates, new Date());
    const dueByDate = new Map(due.map((d) => [d.date, d.scheduledAt]));
    const pastDueSet = new Set(pastDue);

    for (const slot of publishable) {
      // Past-due (or blackout/weekend-excluded → not in `due`) → skip.
      const scheduledAt = dueByDate.get(slot.date);
      if (!scheduledAt || pastDueSet.has(slot.date)) {
        await db
          .update(campaignSlotContent)
          .set({ slotStatus: 'skipped', updatedAt: new Date() })
          .where(eq(campaignSlotContent.id, slot.slotId));
        continue;
      }
      const platform = channelMap.get(slot.channelId);
      if (!platform) {
        await db
          .update(campaignSlotContent)
          .set({ slotStatus: 'skipped', lastError: 'Channel unavailable', updatedAt: new Date() })
          .where(eq(campaignSlotContent.id, slot.slotId));
        continue;
      }

      const { postId, jobId } = await this.publishing.materializeAndEnqueue({
        workspaceId,
        createdById,
        campaignId: id,
        date: slot.date,
        channelId: slot.channelId,
        content: slot.content,
        platform,
        scheduledAt,
      });

      await db
        .update(campaignSlotContent)
        .set({ postId, jobId, scheduledAt, slotStatus: 'scheduled', updatedAt: new Date() })
        .where(eq(campaignSlotContent.id, slot.slotId));
    }

    await db
      .update(campaigns)
      .set({ status: 'active', launchedAt: new Date(), updatedAt: new Date() })
      .where(eq(campaigns.id, id));

    return this.assembleCampaign(id);
  }

  async pause(workspaceId: string, id: string): Promise<CampaignDto> {
    return this.setStatus(workspaceId, id, 'paused');
  }

  async resume(workspaceId: string, id: string): Promise<CampaignDto> {
    return this.setStatus(workspaceId, id, 'active');
  }

  /**
   * Copies the campaign row + all its days + all its slots under a new id.
   * Name gets a " (copy)" suffix, status resets to `draft`. Metrics aren't
   * stored (they're computed on assembly) so there's nothing to reset there.
   */
  async duplicate(
    workspaceId: string,
    userId: string,
    id: string,
  ): Promise<CampaignDto> {
    const source = await this.getOne(workspaceId, id);

    const [copyRow] = await db
      .insert(campaigns)
      .values({
        workspaceId,
        createdById: userId,
        name: `${source.name} (copy)`,
        description: source.description,
        type: source.type,
        status: 'draft',
        schedule: source.schedule,
        contentSource: source.contentSource,
        aiConfig: source.aiConfig,
        libraryTemplateIds: source.libraryTemplateIds,
        channelIds: source.channelIds,
        platforms: source.platforms,
      })
      .returning();

    const [sourceDays, sourceSlots] = await Promise.all([
      db.select().from(campaignDays).where(eq(campaignDays.campaignId, id)),
      db
        .select()
        .from(campaignSlotContent)
        .where(eq(campaignSlotContent.campaignId, id)),
    ]);

    if (sourceDays.length > 0) {
      await db.insert(campaignDays).values(
        sourceDays.map((d) => ({
          campaignId: copyRow.id,
          date: d.date,
          skip: d.skip,
        })),
      );
    }

    if (sourceSlots.length > 0) {
      await db.insert(campaignSlotContent).values(
        sourceSlots.map((s) => ({
          campaignId: copyRow.id,
          date: s.date,
          channelId: s.channelId,
          content: s.content,
        })),
      );
    }

    return this.assembleCampaign(copyRow.id);
  }

  // ── Days ──────────────────────────────────────────────────────────────────

  private async ensureDayRow(campaignId: string, date: string): Promise<void> {
    const [existing] = await db
      .select({ id: campaignDays.id })
      .from(campaignDays)
      .where(
        and(eq(campaignDays.campaignId, campaignId), eq(campaignDays.date, date)),
      );

    if (!existing) {
      await db.insert(campaignDays).values({ campaignId, date });
    }
  }

  async addDay(workspaceId: string, id: string, date: string): Promise<CampaignDto> {
    await this.getOne(workspaceId, id);
    await this.ensureDayRow(id, date);
    await db
      .update(campaigns)
      .set({ updatedAt: new Date() })
      .where(eq(campaigns.id, id));
    return this.assembleCampaign(id);
  }

  async removeDay(workspaceId: string, id: string, date: string): Promise<CampaignDto> {
    await this.getOne(workspaceId, id);
    await db
      .delete(campaignDays)
      .where(and(eq(campaignDays.campaignId, id), eq(campaignDays.date, date)));
    await db
      .delete(campaignSlotContent)
      .where(
        and(eq(campaignSlotContent.campaignId, id), eq(campaignSlotContent.date, date)),
      );
    await db
      .update(campaigns)
      .set({ updatedAt: new Date() })
      .where(eq(campaigns.id, id));
    await this.refreshChannelCache(id);
    return this.assembleCampaign(id);
  }

  async setDaySkip(
    workspaceId: string,
    id: string,
    date: string,
    skip: boolean,
  ): Promise<CampaignDto> {
    await this.getOne(workspaceId, id);
    await this.ensureDayRow(id, date);
    await db
      .update(campaignDays)
      .set({ skip })
      .where(and(eq(campaignDays.campaignId, id), eq(campaignDays.date, date)));
    await db
      .update(campaigns)
      .set({ updatedAt: new Date() })
      .where(eq(campaigns.id, id));
    return this.assembleCampaign(id);
  }

  // ── Events (slots) ───────────────────────────────────────────────────────

  /**
   * Upserts a slot row with a blank `emptyChannelDayContent` payload, ensures
   * the day row exists, then refreshes the channel cache — channels are added
   * per-day (no separate campaign-level picker), so the campaign's channel
   * set is the union of channels used on any day (mock store comment,
   * reproduced here).
   */
  async addEvent(
    workspaceId: string,
    id: string,
    dto: AddEventDto,
  ): Promise<CampaignDto> {
    const campaign = await this.getOne(workspaceId, id);
    await this.ensureDayRow(id, dto.date);

    const content = this.emptyChannelDayContent(
      dto.postType ?? 'text',
      campaign.contentSource,
    );

    const [existingSlot] = await db
      .select({ id: campaignSlotContent.id })
      .from(campaignSlotContent)
      .where(
        and(
          eq(campaignSlotContent.campaignId, id),
          eq(campaignSlotContent.date, dto.date),
          eq(campaignSlotContent.channelId, dto.channelId),
        ),
      );

    if (existingSlot) {
      await db
        .update(campaignSlotContent)
        .set({ content, updatedAt: new Date() })
        .where(eq(campaignSlotContent.id, existingSlot.id));
    } else {
      await db.insert(campaignSlotContent).values({
        campaignId: id,
        date: dto.date,
        channelId: dto.channelId,
        content,
      });
    }

    await db
      .update(campaigns)
      .set({ updatedAt: new Date() })
      .where(eq(campaigns.id, id));

    await this.refreshChannelCache(id);
    return this.assembleCampaign(id);
  }

  /** Merges `patch` into the slot's `content` jsonb (shallow spread over the
   *  existing content, mirroring the mock store's `{ ...existing, ...patch
   *  }`). 404s if the slot doesn't exist. */
  async updateEvent(
    workspaceId: string,
    id: string,
    dto: UpdateEventDto,
  ): Promise<CampaignDto> {
    await this.getOne(workspaceId, id);

    const [slot] = await db
      .select()
      .from(campaignSlotContent)
      .where(
        and(
          eq(campaignSlotContent.campaignId, id),
          eq(campaignSlotContent.date, dto.date),
          eq(campaignSlotContent.channelId, dto.channelId),
        ),
      );

    if (!slot) {
      throw new NotFoundException('Event not found');
    }

    const mergedContent: ChannelDayContentJson = { ...slot.content, ...dto.patch };

    await db
      .update(campaignSlotContent)
      .set({ content: mergedContent, updatedAt: new Date() })
      .where(eq(campaignSlotContent.id, slot.id));

    await db
      .update(campaigns)
      .set({ updatedAt: new Date() })
      .where(eq(campaigns.id, id));

    return this.assembleCampaign(id);
  }

  async removeEvent(
    workspaceId: string,
    id: string,
    dto: RemoveEventDto,
  ): Promise<CampaignDto> {
    await this.getOne(workspaceId, id);

    await db
      .delete(campaignSlotContent)
      .where(
        and(
          eq(campaignSlotContent.campaignId, id),
          eq(campaignSlotContent.date, dto.date),
          eq(campaignSlotContent.channelId, dto.channelId),
        ),
      );

    await db
      .update(campaigns)
      .set({ updatedAt: new Date() })
      .where(eq(campaigns.id, id));

    await this.refreshChannelCache(id);
    return this.assembleCampaign(id);
  }

  // ── AI mock (Phase 1) ────────────────────────────────────────────────────

  private async loadSlotOrThrow(
    campaignId: string,
    date: string,
    channelId: string,
  ): Promise<CampaignSlotContent> {
    const [slot] = await db
      .select()
      .from(campaignSlotContent)
      .where(
        and(
          eq(campaignSlotContent.campaignId, campaignId),
          eq(campaignSlotContent.date, date),
          eq(campaignSlotContent.channelId, channelId),
        ),
      );

    if (!slot) {
      throw new NotFoundException('Event not found');
    }

    return slot;
  }

  private async writeSlotContent(
    slotId: string,
    content: ChannelDayContentJson,
  ): Promise<void> {
    await db
      .update(campaignSlotContent)
      .set({ content, updatedAt: new Date() })
      .where(eq(campaignSlotContent.id, slotId));
  }

  /**
   * Mock AI generation for one slot: fills a placeholder caption (only if
   * blank — a hand-edited caption is preserved) and sets `mode: 'ai'`.
   * Autopilot (`approvalMode: 'auto'`) campaigns mark it approved (ready to
   * publish); ask-before (`preview`) leaves it `pending_review` so it
   * surfaces in the approval queue. Phase 1: no real LLM call.
   */
  async generateAi(
    workspaceId: string,
    id: string,
    date: string,
    channelId: string,
  ): Promise<CampaignDto> {
    const campaign = await this.getOne(workspaceId, id);
    const slot = await this.loadSlotOrThrow(id, date, channelId);

    const aiConfig = campaign.aiConfig as AiAutopilotConfigJson | null;
    const nextContent: ChannelDayContentJson = {
      ...slot.content,
      mode: 'ai',
      caption:
        slot.content.caption.trim().length > 0
          ? slot.content.caption
          : this.mockAiCaption(date, aiConfig),
      aiSubState: aiConfig?.approvalMode === 'preview' ? 'pending_review' : 'approved',
    };

    await this.writeSlotContent(slot.id, nextContent);
    await db
      .update(campaigns)
      .set({ updatedAt: new Date() })
      .where(eq(campaigns.id, id));

    return this.assembleCampaign(id);
  }

  /** User approved an AI-generated draft (or hand-edited and saved it) —
   *  marks it ready to publish. */
  async approveAi(
    workspaceId: string,
    id: string,
    date: string,
    channelId: string,
  ): Promise<CampaignDto> {
    await this.getOne(workspaceId, id);
    const slot = await this.loadSlotOrThrow(id, date, channelId);

    await this.writeSlotContent(slot.id, { ...slot.content, aiSubState: 'approved' });
    await db
      .update(campaigns)
      .set({ updatedAt: new Date() })
      .where(eq(campaigns.id, id));

    return this.assembleCampaign(id);
  }

  /** User skipped an AI-generated draft — it won't publish for this slot. */
  async skipAi(
    workspaceId: string,
    id: string,
    date: string,
    channelId: string,
  ): Promise<CampaignDto> {
    await this.getOne(workspaceId, id);
    const slot = await this.loadSlotOrThrow(id, date, channelId);

    await this.writeSlotContent(slot.id, { ...slot.content, aiSubState: 'skipped' });
    await db
      .update(campaigns)
      .set({ updatedAt: new Date() })
      .where(eq(campaigns.id, id));

    return this.assembleCampaign(id);
  }

  // ── Channel cache ────────────────────────────────────────────────────────

  /**
   * Recomputes the campaign's `channelIds`/`platforms` cache columns as the
   * union of `channelId` across its slot rows, resolving each channel's
   * platform via `socialMediaChannels` (unresolved/deleted channels are
   * skipped rather than failing the whole refresh). Called after any op that
   * changes the slot set (`addEvent`/`removeEvent`/`removeDay`).
   */
  private async refreshChannelCache(campaignId: string): Promise<void> {
    const slots = await db
      .select({ channelId: campaignSlotContent.channelId })
      .from(campaignSlotContent)
      .where(eq(campaignSlotContent.campaignId, campaignId));

    const channelIds = this.computeChannelIdUnion(slots);

    let platforms: string[] = [];
    if (channelIds.length > 0) {
      // Slot channelId is the stringified numeric channel id (frontend sends
      // String(dto.id)); coerce back to number to match
      // socialMediaChannels.id (bigserial). Non-numeric ids are skipped.
      const numericIds = channelIds
        .map((cid) => Number(cid))
        .filter((n) => Number.isFinite(n));

      const channelRows = numericIds.length
        ? await db
            .select({ id: socialMediaChannels.id, platform: socialMediaChannels.platform })
            .from(socialMediaChannels)
            .where(inArray(socialMediaChannels.id, numericIds))
        : [];

      platforms = [...new Set(channelRows.map((r) => r.platform))];
    }

    await db
      .update(campaigns)
      .set({ channelIds, platforms })
      .where(eq(campaigns.id, campaignId));
  }

  private groupBy<T, K>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
    const map = new Map<K, T[]>();
    for (const item of items) {
      const key = keyFn(item);
      const bucket = map.get(key);
      if (bucket) {
        bucket.push(item);
      } else {
        map.set(key, [item]);
      }
    }
    return map;
  }
}
