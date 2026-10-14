import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { AiTextService } from '../ai/ai-text.service';
import { AiTokenService } from '../ai/services/ai-token.service';
import { FirstWeekRepository, type NewDraftRow } from './first-week.repository';
import { FirstWeekStockImageService } from './first-week-stock-image.service';
import type { BrandInput, FirstWeekJobData } from './first-week.types';
import { FIRST_WEEK_SOURCE, firstWeekDraftId } from './lib/first-week-metadata';
import { parseBrandJson, parseDraftJson } from './lib/first-week-parse';
import { buildBrandPrompt, buildDraftPrompt } from './lib/first-week-prompts';
import {
  computeSlots,
  describeSlot,
  resolveWeekStart,
} from './lib/first-week-slots';
import {
  MIN_CAPTIONS,
  chooseSourceChannel,
  selectTargets,
} from './lib/first-week-targets';
import { slotOf } from './lib/first-week-view';

export type RunOutcome =
  | 'ready'
  | 'needs_description'
  | 'no_tokens'
  | 'skipped';

/** Another run already wrote this slot's draft; abort the metered call so nothing is deducted. */
class SlotTakenError extends Error {
  constructor(slot: number) {
    super(`First-week slot ${slot} was already drafted`);
  }
}

/** executeWithTokens' own refusal (a token race after hasTokens), as opposed to a failure of the work. */
const isTokenShortage = (err: unknown): boolean =>
  err instanceof BadRequestException || err instanceof ForbiddenException;

/** How many of the person's own posts to show the model as style examples. */
const SAMPLE_CAPTIONS = 6;
const MAX_ERROR_CHARS = 500;

type Learned =
  | { kind: 'ok'; brand: BrandInput; captions: string[] }
  | { kind: 'needs_description' }
  | { kind: 'no_tokens' };

/**
 * One first-week run: (optionally) learn the brand from published posts, then
 * draft five posts. Every step is safe to repeat:
 *   - a brand that is already stored is never re-learned (or re-charged);
 *   - a slot that already has a draft is skipped, and the draft id is
 *     deterministic so a concurrent run's INSERT is a no-op;
 *   - tokens are only deducted after the model's answer parsed.
 * A normal "stop" (not enough posts, out of tokens) is a return value; an
 * unexpected error is thrown so BullMQ retries, and the processor marks the
 * profile `failed` only after the last attempt.
 */
@Injectable()
export class FirstWeekRunService {
  private readonly logger = new Logger(FirstWeekRunService.name);

  constructor(
    private readonly repo: FirstWeekRepository,
    private readonly tokens: AiTokenService,
    private readonly ai: AiTextService,
    private readonly stock: FirstWeekStockImageService,
  ) {}

  async execute(
    job: FirstWeekJobData,
    now: Date = new Date(),
  ): Promise<RunOutcome> {
    const { workspaceId } = job;
    const profile = await this.repo.getProfile(workspaceId);
    if (!profile) {
      this.logger.warn(`First week: no profile for ${workspaceId}, skipping`);
      return 'skipped';
    }
    if (profile.status === 'ready') return 'skipped';
    const ws = await this.repo.getWorkspace(workspaceId);
    if (!ws) return 'skipped';
    const userId = job.userId ?? ws.ownerId;

    let brand: BrandInput | null =
      profile.sells && profile.audience && profile.voice.length > 0
        ? {
            sells: profile.sells,
            voice: profile.voice,
            audience: profile.audience,
          }
        : null;
    let samples: string[] = [];

    if (!brand) {
      if (job.mode === 'described') {
        await this.repo.setStatus(workspaceId, 'needs_description');
        return 'needs_description';
      }
      const learned = await this.learnBrand(workspaceId, userId);
      if (learned.kind !== 'ok') return learned.kind;
      brand = learned.brand;
      samples = learned.captions.slice(0, SAMPLE_CAPTIONS);
    } else if (profile.source === 'posts' && profile.sourceChannelId != null) {
      samples = await this.repo.getCaptionsForChannel(
        workspaceId,
        profile.sourceChannelId,
        SAMPLE_CAPTIONS,
      );
    }

    return this.draftWeek({
      workspaceId,
      userId,
      timezone: ws.timezone,
      weekStartsOn: profile.weekStartsOn,
      brand,
      samples,
      now,
    });
  }

  async markFailed(workspaceId: string, message: string): Promise<void> {
    await this.repo.setStatus(
      workspaceId,
      'failed',
      message.slice(0, MAX_ERROR_CHARS),
    );
  }

  private async hasTokens(
    workspaceId: string,
    operation: string,
  ): Promise<boolean> {
    return (await this.tokens.checkTokens(workspaceId, operation)).hasAccess;
  }

  private async learnBrand(
    workspaceId: string,
    userId: string,
  ): Promise<Learned> {
    await this.repo.setStatus(workspaceId, 'reading');

    const source = chooseSourceChannel(
      await this.repo.listSourceCandidates(workspaceId),
    );
    if (!source || source.captions.length < MIN_CAPTIONS) {
      await this.repo.setStatus(workspaceId, 'needs_description');
      return { kind: 'needs_description' };
    }

    if (!(await this.hasTokens(workspaceId, 'brand_learn'))) {
      await this.repo.setStatus(workspaceId, 'no_tokens');
      return { kind: 'no_tokens' };
    }

    const { system, user } = buildBrandPrompt({
      platform: source.platform,
      captions: source.captions,
    });
    // Parse INSIDE the metered operation: executeWithTokens only deducts when
    // the callback resolves, so an unparseable answer costs the person nothing.
    const { result: brand } = await this.tokens.executeWithTokens(
      workspaceId,
      userId,
      'brand_learn',
      source.platform,
      `Brand profile from ${source.captions.length} ${source.platform} posts`,
      async () => {
        const raw = await this.ai.complete(system, user, {
          temperature: 0.3,
          maxTokens: 512,
        });
        return { result: parseBrandJson(raw), outputLength: raw.length };
      },
    );

    await this.repo.saveLearnedBrand(workspaceId, {
      brand,
      sourceChannelId: source.channelId,
      sourcePlatform: source.platform,
      postsRead: source.captions.length,
    });
    if (source.platform === 'instagram' && source.profilePictureUrl) {
      await this.repo.setWorkspaceLogoIfEmpty(
        workspaceId,
        source.profilePictureUrl,
      );
    }
    return { kind: 'ok', brand, captions: source.captions };
  }

  private async draftWeek(input: {
    workspaceId: string;
    userId: string;
    timezone: string;
    weekStartsOn: string | null;
    brand: BrandInput;
    samples: string[];
    now: Date;
  }): Promise<RunOutcome> {
    const { workspaceId, userId, timezone, brand, samples, now } = input;

    const weekStart = resolveWeekStart(now, timezone, input.weekStartsOn);
    const slots = computeSlots(weekStart, timezone);
    await this.repo.setWeek(workspaceId, {
      weekStartsOn: weekStart,
      weekEndsAt: slots[slots.length - 1].at,
    });

    const channels = await this.repo.listPublishingChannels(workspaceId);
    const targets = selectTargets(channels);
    const platforms = [...new Set(targets.map((t) => t.platform))];

    const existing = await this.repo.listFirstWeekDrafts(workspaceId);
    const doneSlots = new Set<number>();
    const captions: string[] = [];
    for (const row of existing) {
      const slot = slotOf(row);
      if (slot !== null) doneSlots.add(slot);
      if (row.content) captions.push(row.content);
    }

    for (const slot of slots) {
      if (doneSlots.has(slot.slot)) continue;

      if (!(await this.hasTokens(workspaceId, 'first_week_draft'))) {
        await this.repo.refreshDraftedCount(workspaceId);
        await this.repo.setStatus(workspaceId, 'no_tokens');
        return 'no_tokens';
      }

      const when = describeSlot(slot.at, timezone);
      const { system, user } = buildDraftPrompt({
        brand,
        weekday: when.weekday,
        time: when.time,
        slot: slot.slot,
        sampleCaptions: samples,
        previousCaptions: captions,
        platforms,
      });
      // The stock lookup and the INSERT run inside the metered callback:
      // tokens are deducted only after the row is safely written, so a failed
      // insert (retry) or a slot another run filled first is never charged.
      let draft: ReturnType<typeof parseDraftJson>;
      try {
        ({
          result: { draft },
        } = await this.tokens.executeWithTokens(
          workspaceId,
          userId,
          'first_week_draft',
          platforms.join(',') || undefined,
          `First-week post ${slot.slot + 1} of 5`,
          async () => {
            const raw = await this.ai.complete(system, user, {
              temperature: 0.8,
              maxTokens: 400,
            });
            const parsed = parseDraftJson(raw);
            const image = await this.stock.find(parsed.imageQuery);
            const inserted = await this.repo.insertDraft({
              id: firstWeekDraftId(workspaceId, slot.slot),
              workspaceId,
              createdById: userId,
              content: parsed.caption,
              mediaItems: (image
                ? [
                    {
                      id: randomUUID(),
                      type: 'image',
                      url: image.url,
                      width: image.width,
                      height: image.height,
                      altText: image.alt,
                      sizeBytes: 0,
                    },
                  ]
                : []) as unknown as NewDraftRow['mediaItems'],
              targets: targets as unknown as NewDraftRow['targets'],
              status: 'draft',
              platformContent: {},
              metadata: {
                source: FIRST_WEEK_SOURCE,
                firstWeekSlot: slot.slot,
                suggestedAt: slot.at.toISOString(),
                ...(image ? { imageCredit: image.credit } : {}),
              } as unknown as NewDraftRow['metadata'],
            });
            if (!inserted) throw new SlotTakenError(slot.slot);
            return { result: { draft: parsed }, outputLength: raw.length };
          },
        ));
      } catch (err) {
        if (err instanceof SlotTakenError) {
          doneSlots.add(slot.slot);
          continue;
        }
        if (isTokenShortage(err)) {
          await this.repo.refreshDraftedCount(workspaceId);
          await this.repo.setStatus(workspaceId, 'no_tokens');
          return 'no_tokens';
        }
        throw err;
      }
      captions.push(draft.caption);
      doneSlots.add(slot.slot);
      await this.repo.refreshDraftedCount(workspaceId);
    }

    await this.repo.setStatus(workspaceId, 'ready');
    return 'ready';
  }
}
