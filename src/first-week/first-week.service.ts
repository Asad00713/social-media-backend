import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { BrandProfileRow } from '../drizzle/schema/workspace-brand-profile.schema';
import { AiTokenService } from '../ai/services/ai-token.service';
import { ComposerSchedulingService } from '../posts/composer/services/composer-scheduling.service';
import { DraftStoreService } from '../posts/composer/services/draft-store.service';
import { FirstWeekQueueService } from './first-week-queue.service';
import { FirstWeekRepository } from './first-week.repository';
import {
  RETRYABLE_STATUSES,
  STALE_RUN_MS,
  type BrandInput,
  type FirstWeekDraft,
  type FirstWeekJobData,
  type FirstWeekMode,
  type FirstWeekProfileView,
  type FirstWeekState,
  type SkipReason,
} from './first-week.types';
import { LlmOutputError, normaliseBrand } from './lib/first-week-parse';
import { safeTimeZone } from './lib/first-week-slots';
import { toDraftView, toProfileView } from './lib/first-week-view';

export interface ScheduleResult {
  scheduled: string[];
  skipped: Array<{ id: string; reason: SkipReason }>;
}

/** A reading/drafting run that has gone quiet for STALE_RUN_MS. */
function isStalled(profile: BrandProfileRow, now: Date): boolean {
  return (
    (profile.status === 'reading' || profile.status === 'drafting') &&
    now.getTime() - profile.updatedAt.getTime() > STALE_RUN_MS
  );
}

const unique = (ids: string[]): string[] => [...new Set(ids)];

@Injectable()
export class FirstWeekService {
  private readonly logger = new Logger(FirstWeekService.name);

  constructor(
    private readonly repo: FirstWeekRepository,
    private readonly queue: FirstWeekQueueService,
    private readonly drafts: DraftStoreService,
    private readonly scheduling: ComposerSchedulingService,
    private readonly tokens: AiTokenService,
  ) {}

  async getState(
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<FirstWeekState> {
    const [profile, rows, channelCount, ws, usage] = await Promise.all([
      this.repo.getProfile(workspaceId),
      this.repo.listFirstWeekDrafts(workspaceId),
      this.repo.countPublishingChannels(workspaceId),
      this.repo.getWorkspace(workspaceId),
      this.tokens.getWorkspaceAiUsage(workspaceId),
    ]);
    if (!ws) throw new NotFoundException('Workspace not found');

    const drafts = rows
      .map((r) => toDraftView(r, now))
      .filter((d): d is FirstWeekDraft => d !== null)
      .sort((a, b) => a.slot - b.slot);

    return {
      profile: profile ? this.viewOf(profile, now) : null,
      drafts,
      hasChannels: channelCount > 0,
      timezone: safeTimeZone(ws.timezone),
      tokensResetAt: usage.resetsAt ? usage.resetsAt.toISOString() : null,
    };
  }

  /**
   * Describe / Edit.
   *   - No profile yet, or one whose brand was never learned (needs_description,
   *     failed or no_tokens before learning): this is the person's first
   *     description. Store it as the source and start a `described` run.
   *   - A brand already exists (learned or described): update the words only.
   *     No redraft (spec).
   */
  async saveBrand(
    workspaceId: string,
    userId: string,
    dto: { sells: string; voice: string[]; audience: string },
    now: Date = new Date(),
  ): Promise<FirstWeekProfileView> {
    let brand: BrandInput;
    try {
      brand = normaliseBrand(dto);
    } catch (err) {
      if (err instanceof LlmOutputError)
        throw new BadRequestException(err.message);
      throw err;
    }

    const existing = await this.repo.getProfile(workspaceId);
    if (!existing) {
      const created = await this.repo.insertProfileIfAbsent(workspaceId, {
        source: 'described',
        status: 'drafting',
        brand,
      });
      if (created) {
        await this.start({ workspaceId, mode: 'described', userId });
      } else {
        // Lost a race with the backfill trigger: treat as an edit.
        await this.repo.updateBrand(workspaceId, brand);
      }
    } else if (this.isRetryable(existing, now)) {
      // Effective status is failed-like (including a stalled run): store the
      // brand, then re-run exactly as retry does.
      if (existing.sells) {
        await this.repo.updateBrand(workspaceId, brand);
        await this.rerun(existing, userId);
      } else {
        await this.repo.saveDescribedBrand(workspaceId, brand);
        await this.rerun({ ...existing, source: 'described' }, userId);
      }
    } else if (!existing.sells) {
      // Fresh reading with no brand yet.
      throw new ConflictException(
        'Maestro is still reading your posts. Try again in a moment.',
      );
    } else {
      // Fresh drafting or ready: an edit of the words only, no redraft.
      await this.repo.updateBrand(workspaceId, brand);
    }
    return this.profileViewOrThrow(workspaceId);
  }

  /** Try again: only from failed, needs_description, no_tokens or a stalled run, in the mode the profile already has. */
  async retry(
    workspaceId: string,
    userId: string,
    now: Date = new Date(),
  ): Promise<FirstWeekProfileView> {
    const profile = await this.repo.getProfile(workspaceId);
    if (!profile)
      throw new NotFoundException('There is no first week to retry');
    if (!this.isRetryable(profile, now)) {
      throw new ConflictException(
        `A first week in status "${profile.status}" cannot be retried`,
      );
    }
    await this.rerun(profile, userId);
    return this.profileViewOrThrow(workspaceId);
  }

  /** failed / needs_description / no_tokens, or a reading/drafting run that has stalled. */
  private isRetryable(profile: BrandProfileRow, now: Date): boolean {
    return (
      RETRYABLE_STATUSES.includes(profile.status) || isStalled(profile, now)
    );
  }

  private async rerun(profile: BrandProfileRow, userId: string): Promise<void> {
    const workspaceId = profile.workspaceId;
    const mode: FirstWeekMode = profile.source;
    // Back to reading only when the brand still has to be learned; otherwise
    // pick up at drafting (the run never re-learns, or re-charges, a stored brand).
    const next = mode === 'posts' && !profile.sells ? 'reading' : 'drafting';
    await this.repo.setStatus(workspaceId, next, null);
    await this.start({ workspaceId, mode, userId });
  }

  /**
   * Schedule first-week drafts, each at its own `suggestedAt`, through the
   * composer's schedule path (queue ceiling, BullMQ delayed job, calendar push).
   * Only ids that are this workspace's first-week posts are ever touched.
   */
  async schedule(
    workspaceId: string,
    userId: string,
    postIds: string[],
    now: Date = new Date(),
  ): Promise<ScheduleResult> {
    const rows = await this.repo.listFirstWeekDrafts(workspaceId);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const result: ScheduleResult = { scheduled: [], skipped: [] };

    // Sequential on purpose: each schedule counts against the channel queue ceiling.
    for (const id of unique(postIds)) {
      const row = byId.get(id);
      const view = row ? toDraftView(row, now) : null;
      if (!row || !view) {
        result.skipped.push({ id, reason: 'not_found' });
        continue;
      }
      if (view.blockedReason) {
        result.skipped.push({ id, reason: view.blockedReason });
        continue;
      }
      try {
        const draft = await this.drafts.findById(workspaceId, id);
        await this.scheduling.schedule(workspaceId, userId, {
          draftId: id,
          scheduledAt: view.suggestedAt,
          base: draft.base,
          perPlatform: draft.perPlatform,
          channels: draft.channels,
        });
        result.scheduled.push(id);
      } catch (err) {
        result.skipped.push({ id, reason: this.skipReasonOf(err) });
      }
    }
    return result;
  }

  /** Cancel the jobs and return posts to draft. Only first-week posts that are still `scheduled`. */
  async unschedule(
    workspaceId: string,
    postIds: string[],
  ): Promise<{ unscheduled: string[] }> {
    const rows = await this.repo.listFirstWeekDrafts(workspaceId);
    const scheduled = new Set(
      rows.filter((r) => r.status === 'scheduled').map((r) => r.id),
    );
    const unscheduled: string[] = [];
    for (const id of unique(postIds)) {
      if (!scheduled.has(id)) continue;
      await this.scheduling.cancel(workspaceId, id);
      unscheduled.push(id);
    }
    return { unscheduled };
  }

  /** Read-time only: a stalled run is shown as failed, nothing is written. */
  private viewOf(profile: BrandProfileRow, now: Date): FirstWeekProfileView {
    const view = toProfileView(profile);
    return isStalled(profile, now)
      ? { ...view, status: 'failed', error: 'stalled' }
      : view;
  }

  private skipReasonOf(err: unknown): SkipReason {
    if (err instanceof ForbiddenException) return 'queue_full';
    if (err instanceof BadRequestException) return 'past';
    this.logger.error(
      `Scheduling a first-week draft failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 'error';
  }

  /** Enqueue; if that fails, do not leave the profile claiming a run is in flight. */
  private async start(job: FirstWeekJobData): Promise<void> {
    try {
      await this.queue.enqueue(job);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.repo.setStatus(
        job.workspaceId,
        'failed',
        `Could not start: ${message}`,
      );
      throw err;
    }
  }

  private async profileViewOrThrow(
    workspaceId: string,
  ): Promise<FirstWeekProfileView> {
    const profile = await this.repo.getProfile(workspaceId);
    if (!profile) throw new NotFoundException('First week not found');
    return this.viewOf(profile, new Date());
  }
}
