import { Inject, Injectable, Logger } from '@nestjs/common';
import { getCapabilities } from '../platform-capabilities.registry';
import type { SupportedPlatform } from '../../../drizzle/schema/channels.schema';

export interface RedisLike {
  get(key: string): Promise<string | null>;
  incrby(key: string, by: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

export interface QuotaConsumeResult {
  allowed: boolean;
  remaining: number;
}

/**
 * Per-platform daily quota tracker backed by Redis. Adapters must call
 * tryConsume BEFORE every API call and skip the call if allowed: false.
 * Fails open (allows calls) when no quota budget is registered for a platform.
 */
@Injectable()
export class QuotaTrackerService {
  private readonly logger = new Logger(QuotaTrackerService.name);

  constructor(@Inject('REDIS_CLIENT') private readonly redis: RedisLike) {}

  async tryConsume(platform: SupportedPlatform, cost: number): Promise<QuotaConsumeResult> {
    const budget = this.getBudget(platform);
    if (budget === null) {
      return { allowed: true, remaining: Number.POSITIVE_INFINITY };
    }

    const key = `quota:${platform}:${this.dayKey()}`;
    const current = Number((await this.redis.get(key)) ?? '0');
    const threshold = Math.floor(budget * 0.95);

    if (current + cost > threshold) {
      this.logger.warn(`Quota near-exhausted for ${platform}: ${current}/${budget} (threshold ${threshold})`);
      return { allowed: false, remaining: budget - current };
    }

    const next = await this.redis.incrby(key, cost);
    await this.redis.expire(key, 30 * 60 * 60);

    return { allowed: true, remaining: budget - next };
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
