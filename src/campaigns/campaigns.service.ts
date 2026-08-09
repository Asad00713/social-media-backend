import { Injectable, Logger, NotFoundException } from '@nestjs/common';
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

const ACTIVE_NEXT_RUN_STATUSES = new Set(['active', 'scheduled']);

// Hard stop for the day-by-day scan in computeNextRun so a malformed
// schedule (e.g. end < start) can never loop indefinitely.
const MAX_NEXT_RUN_SCAN_DAYS = 3660; // ~10 years

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

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
      if (!end && i >= MAX_NEXT_RUN_SCAN_DAYS - 1) break;
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
      ? rows.filter((r) =>
          r.name.toLowerCase().includes(filters.search!.toLowerCase()),
        )
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
