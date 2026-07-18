import { Inject, Injectable, Logger } from '@nestjs/common';
import { getCapabilities } from '../platform-capabilities.registry';
import type { SupportedPlatform } from '../../../drizzle/schema/channels.schema';

export interface RedisLike {
  get(key: string): Promise<string | null>;
  incrby(key: string, by: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  ttl(key: string): Promise<number>;
}

export interface QuotaConsumeResult {
  allowed: boolean;
  remaining: number;
}

export type QuotaSubsystem = 'publishing' | 'analytics' | 'inbox';

/**
 * Slices of a platform's daily budget, per subsystem.
 *
 * Without this split a runaway inbox poll drains the same counter publishing
 * draws on, so the user's paid-for action fails because of a background job.
 * Publishing wins ties: it is the thing the user actually asked for.
 *
 * YouTube's 10,000 shared units: 2,000 publishing + 5,000 analytics +
 * 3,000 inbox. The inbox slice matches YOUTUBE_INBOX_DAILY_UNITS' default.
 */
const SUBSYSTEM_ALLOWANCES: Partial<
  Record<SupportedPlatform, Record<QuotaSubsystem, number>>
> = {
  youtube: { publishing: 2000, analytics: 5000, inbox: 3000 },
};

/**
 * Per-platform daily quota tracker backed by Redis. Adapters must call
 * tryConsume BEFORE every API call and skip the call if allowed: false.
 * Fails open (allows calls) when no quota budget is registered for a platform.
 */
@Injectable()
export class QuotaTrackerService {
  private readonly logger = new Logger(QuotaTrackerService.name);

  constructor(@Inject('REDIS_CLIENT') private readonly redis: RedisLike) {}

  async tryConsume(
    platform: SupportedPlatform,
    cost: number,
    subsystem?: QuotaSubsystem,
  ): Promise<QuotaConsumeResult> {
    const budget = this.resolveBudget(platform, subsystem);
    if (budget === null) {
      return { allowed: true, remaining: Number.POSITIVE_INFINITY };
    }

    const scope = subsystem ? `${platform}:${subsystem}` : platform;
    const key = `quota:${scope}:${this.dayKey()}`;
    const current = Number((await this.redis.get(key)) ?? '0');
    const threshold = Math.floor(budget * 0.95);

    if (current + cost > threshold) {
      this.logger.warn(
        `Quota near-exhausted for ${scope}: ${current}/${budget} (threshold ${threshold})`,
      );
      return { allowed: false, remaining: budget - current };
    }

    const next = await this.redis.incrby(key, cost);
    await this.redis.expire(key, 30 * 60 * 60);

    return { allowed: true, remaining: budget - next };
  }

  /**
   * The ceiling this call is measured against: the subsystem's slice when one
   * is named and defined, otherwise the platform's whole daily budget.
   */
  private resolveBudget(
    platform: SupportedPlatform,
    subsystem?: QuotaSubsystem,
  ): number | null {
    if (subsystem) {
      const allowance = SUBSYSTEM_ALLOWANCES[platform]?.[subsystem];
      if (allowance !== undefined) return allowance;
    }
    return this.getBudget(platform);
  }

  private getBudget(platform: SupportedPlatform): number | null {
    try {
      return getCapabilities(platform).dailyQuotaBudget;
    } catch {
      // Platform not in registry (e.g. cloud-storage) — no quota tracking needed
      return null;
    }
  }

  private dayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }
}
