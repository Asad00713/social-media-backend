import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  pickYoutubeInboxTier,
  isDueForPoll,
  type YoutubeInboxTier,
} from '../utils/youtube-inbox-tier.util';

/** Subset of ioredis used here — same pattern as TikTokQuotaService. */
export interface YoutubeInboxBudgetRedis {
  mget(keys: string[]): Promise<(string | null)[]>;
  set(key: string, value: string): Promise<unknown>;
  /**
   * Also used with a negative `by` to give back units that were spent
   * optimistically but did not fit under the daily allowance — same
   * incr/decr-pair pattern as TikTokQuotaService, but a single atomic
   * primitive (Redis INCRBY accepts negative deltas) instead of two.
   */
  incrby(key: string, by: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

export interface PollCandidate {
  videoId: string;
  publishedAtMs: number;
}

export interface PollSelection {
  due: PollCandidate[];
  deferred: number;
  deferredByTier: Record<string, number>;
}

const DEFAULT_DAILY_UNITS = 3000;
/** commentThreads.list is 1 unit/page, and after early exit a poll is ~1 page. */
const UNITS_PER_VIDEO = 1;
/** Just past the cold cutoff (30d) so aged-out per-video keys self-expire. */
const LAST_POLL_TTL_SECONDS = 40 * 24 * 60 * 60;
const UNITS_TTL_SECONDS = 30 * 60 * 60;

const TIER_ORDER: YoutubeInboxTier['name'][] = ['hot', 'warm', 'cool', 'cold'];

/**
 * Picks which of a channel's videos may have their comments polled right now.
 *
 * Two gates, in order:
 *   1. Tier — has this video's poll interval elapsed? (cold videos: never)
 *   2. Budget — does it fit in today's YOUTUBE_INBOX_DAILY_UNITS allowance?
 *
 * Tiering alone is not enough: cost scales with the number of videos, so an
 * interval that is safe for one channel is unsafe for ten. The allowance caps
 * the total regardless of how many channels exist, and hot videos are served
 * first so the newest comments — the ones users are waiting on — never lose
 * their budget to a six-hour cool-tier sweep.
 *
 * State lives in Redis rather than Postgres so this needs no migration, and
 * so the allowance is shared across workers.
 */
@Injectable()
export class YoutubeInboxBudgetService {
  private readonly logger = new Logger(YoutubeInboxBudgetService.name);

  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: YoutubeInboxBudgetRedis,
  ) {}

  private get dailyUnits(): number {
    const raw = Number(process.env.YOUTUBE_INBOX_DAILY_UNITS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_UNITS;
  }

  private dayKey(nowMs: number): string {
    return new Date(nowMs).toISOString().slice(0, 10);
  }

  private unitsKey(nowMs: number): string {
    return `yt:inboxpoll:units:${this.dayKey(nowMs)}`;
  }

  private lastPollKey(channelId: number, videoId: string): string {
    return `yt:inboxpoll:${channelId}:${videoId}`;
  }

  async selectDue(
    channelId: number,
    candidates: PollCandidate[],
    nowMs: number,
  ): Promise<PollSelection> {
    const empty: PollSelection = { due: [], deferred: 0, deferredByTier: {} };
    if (candidates.length === 0) return empty;

    const lastPolled = await this.redis.mget(
      candidates.map((c) => this.lastPollKey(channelId, c.videoId)),
    );

    // Tier gate. Cold videos are dropped outright — not "deferred", since no
    // amount of budget would ever make them eligible.
    const eligible: Array<{
      candidate: PollCandidate;
      tier: YoutubeInboxTier;
    }> = [];
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const tier = pickYoutubeInboxTier(nowMs - candidate.publishedAtMs);
      // A missing or unparseable timestamp means "never polled" — poll it.
      const parsed = Number(lastPolled[i]);
      const lastMs =
        lastPolled[i] !== null && Number.isFinite(parsed) ? parsed : null;
      if (isDueForPoll(tier, lastMs, nowMs)) {
        eligible.push({ candidate, tier });
      }
    }
    if (eligible.length === 0) return empty;

    eligible.sort(
      (a, b) =>
        TIER_ORDER.indexOf(a.tier.name) - TIER_ORDER.indexOf(b.tier.name),
    );

    // Spend optimistically for every tier-eligible candidate in one atomic
    // INCRBY, then trim back to the allowance using the total INCRBY
    // returns. A GET-then-INCRBY here would let two channels' selectDue
    // calls interleave: both read the same `spent`, both conclude they
    // have headroom, and both spend against it, overrunning the daily
    // allowance. INCRBY is atomic in Redis, so its return value is
    // authoritative and race-free — no separate read is needed or safe.
    const key = this.unitsKey(nowMs);
    const requested = eligible.length * UNITS_PER_VIDEO;
    const total = await this.redis.incrby(key, requested);
    await this.redis.expire(key, UNITS_TTL_SECONDS);

    // If the atomic spend overshot the allowance, give back the excess and
    // trim the lowest-priority (already tier-sorted) tail of `eligible` —
    // those become deferred instead of due.
    const overshoot = Math.max(0, total - this.dailyUnits);
    const deferredCount = Math.min(
      eligible.length,
      Math.ceil(overshoot / UNITS_PER_VIDEO),
    );
    if (deferredCount > 0) {
      await this.redis.incrby(key, -(deferredCount * UNITS_PER_VIDEO));
    }
    const affordable = eligible.length - deferredCount;
    const spentBeforeThisCall = total - requested;

    const due = eligible.slice(0, affordable);
    const deferredEntries = eligible.slice(affordable);
    const deferredByTier: Record<string, number> = {};
    for (const e of deferredEntries) {
      deferredByTier[e.tier.name] = (deferredByTier[e.tier.name] ?? 0) + 1;
    }

    // An adaptive scheduler that quietly stops polling looks exactly like one
    // that is working. Say so, with counts, every time we defer.
    if (deferredEntries.length > 0) {
      this.logger.warn(
        `YouTube inbox budget: channel ${channelId} deferred ${deferredEntries.length} videos ` +
          `(${JSON.stringify(deferredByTier)}) — ${spentBeforeThisCall}/${this.dailyUnits} units spent today`,
      );
    }

    return {
      due: due.map((e) => e.candidate),
      deferred: deferredEntries.length,
      deferredByTier,
    };
  }

  async markPolled(
    channelId: number,
    videoId: string,
    nowMs: number,
  ): Promise<void> {
    const key = this.lastPollKey(channelId, videoId);
    await this.redis.set(key, String(nowMs));
    await this.redis.expire(key, LAST_POLL_TTL_SECONDS);
  }
}
