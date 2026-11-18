import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { SupportedPlatform } from '../drizzle/schema/channels.schema';

/**
 * The app-wide brake on a runaway publish loop — NOT a customer quota.
 *
 * This table used to hold the platforms' own published numbers, and its
 * comments said so ("Instagram is very strict: 25 per 24 hours"). Those
 * numbers are per CONNECTED ACCOUNT, and they were counted in a single Redis
 * key (`ratelimit:global:<platform>`) shared by every customer. So Instagram's
 * per-account allowance of 25 was enforced as 20 posts per day across all of
 * Schedura: fifty customers shared one customer's budget, and each was refused
 * for traffic none of them sent. No scheduling tool works this way — Buffer
 * publishes per-channel daily caps, and Publer's documentation states its
 * limits are "applied per user account" — because no platform imposes an
 * app-wide posting cap.
 *
 * The per-account denominator lives in {@link PER_CHANNEL_LIMITS}, which is
 * the real limit. What remains here is the one genuinely app-wide concern: a
 * bug that publishes in a loop could get the whole app's API access revoked,
 * which would hit every customer at once. A single high ceiling stops that
 * without standing in any customer's way.
 *
 * Every entry is {@link RUNAWAY_LIMIT_PER_WINDOW}; the windows differ only so
 * each platform's brake is measured over a period that resembles its own
 * limit. A per-account number appearing here again is the regression, and
 * rate-limiter.service.spec.ts fails on it.
 */
export const RUNAWAY_LIMIT_PER_WINDOW = 2000;

export const PLATFORM_RATE_LIMITS: Record<
  SupportedPlatform,
  { maxRequests: number; windowMs: number; description: string }
> = {
  twitter: {
    maxRequests: RUNAWAY_LIMIT_PER_WINDOW,
    windowMs: 3 * 60 * 60 * 1000, // 3 hours
    description: `runaway brake: ${RUNAWAY_LIMIT_PER_WINDOW} app-wide per 3 hours`,
  },
  facebook: {
    maxRequests: RUNAWAY_LIMIT_PER_WINDOW,
    windowMs: 60 * 60 * 1000, // 1 hour
    description: `runaway brake: ${RUNAWAY_LIMIT_PER_WINDOW} app-wide per 1 hour`,
  },
  instagram: {
    maxRequests: RUNAWAY_LIMIT_PER_WINDOW,
    windowMs: 24 * 60 * 60 * 1000, // 24 hours
    description: `runaway brake: ${RUNAWAY_LIMIT_PER_WINDOW} app-wide per 24 hours`,
  },
  linkedin: {
    maxRequests: RUNAWAY_LIMIT_PER_WINDOW,
    windowMs: 24 * 60 * 60 * 1000, // 24 hours
    description: `runaway brake: ${RUNAWAY_LIMIT_PER_WINDOW} app-wide per 24 hours`,
  },
  pinterest: {
    maxRequests: RUNAWAY_LIMIT_PER_WINDOW,
    windowMs: 60 * 60 * 1000, // 1 hour
    description: `runaway brake: ${RUNAWAY_LIMIT_PER_WINDOW} app-wide per 1 hour`,
  },
  tiktok: {
    maxRequests: RUNAWAY_LIMIT_PER_WINDOW,
    windowMs: 24 * 60 * 60 * 1000, // 24 hours
    description: `runaway brake: ${RUNAWAY_LIMIT_PER_WINDOW} app-wide per 24 hours`,
  },
  youtube: {
    maxRequests: RUNAWAY_LIMIT_PER_WINDOW,
    windowMs: 24 * 60 * 60 * 1000, // 24 hours
    description: `runaway brake: ${RUNAWAY_LIMIT_PER_WINDOW} app-wide per 24 hours`,
  },
  threads: {
    maxRequests: RUNAWAY_LIMIT_PER_WINDOW,
    windowMs: 24 * 60 * 60 * 1000, // 24 hours
    description: `runaway brake: ${RUNAWAY_LIMIT_PER_WINDOW} app-wide per 24 hours`,
  },
  bluesky: {
    maxRequests: RUNAWAY_LIMIT_PER_WINDOW,
    windowMs: 60 * 60 * 1000, // 1 hour
    description: `runaway brake: ${RUNAWAY_LIMIT_PER_WINDOW} app-wide per 1 hour`,
  },
  mastodon: {
    maxRequests: RUNAWAY_LIMIT_PER_WINDOW,
    windowMs: 5 * 60 * 1000, // 5 minutes
    description: `runaway brake: ${RUNAWAY_LIMIT_PER_WINDOW} app-wide per 5 minutes`,
  },
  google_business: {
    maxRequests: RUNAWAY_LIMIT_PER_WINDOW,
    windowMs: 60 * 60 * 1000, // 1 hour
    description: `runaway brake: ${RUNAWAY_LIMIT_PER_WINDOW} app-wide per 1 hour`,
  },
  google_drive: {
    maxRequests: RUNAWAY_LIMIT_PER_WINDOW,
    windowMs: 60 * 60 * 1000, // 1 hour
    description: `runaway brake: ${RUNAWAY_LIMIT_PER_WINDOW} app-wide per 1 hour`,
  },
  google_photos: {
    maxRequests: RUNAWAY_LIMIT_PER_WINDOW,
    windowMs: 60 * 60 * 1000, // 1 hour
    description: `runaway brake: ${RUNAWAY_LIMIT_PER_WINDOW} app-wide per 1 hour`,
  },
  google_calendar: {
    maxRequests: RUNAWAY_LIMIT_PER_WINDOW,
    windowMs: 60 * 60 * 1000, // 1 hour
    description: `runaway brake: ${RUNAWAY_LIMIT_PER_WINDOW} app-wide per 1 hour`,
  },
  outlook_calendar: {
    maxRequests: RUNAWAY_LIMIT_PER_WINDOW,
    windowMs: 60 * 60 * 1000, // 1 hour
    description: `runaway brake: ${RUNAWAY_LIMIT_PER_WINDOW} app-wide per 1 hour`,
  },
  onedrive: {
    maxRequests: RUNAWAY_LIMIT_PER_WINDOW,
    windowMs: 10 * 60 * 1000, // 10 minutes
    description: `runaway brake: ${RUNAWAY_LIMIT_PER_WINDOW} app-wide per 10 minutes`,
  },
  dropbox: {
    maxRequests: RUNAWAY_LIMIT_PER_WINDOW,
    windowMs: 60 * 60 * 1000, // 1 hour
    description: `runaway brake: ${RUNAWAY_LIMIT_PER_WINDOW} app-wide per 1 hour`,
  },
  reddit: {
    maxRequests: RUNAWAY_LIMIT_PER_WINDOW,
    windowMs: 60 * 1000, // 1 minute
    description: `runaway brake: ${RUNAWAY_LIMIT_PER_WINDOW} app-wide per 1 minute`,
  },
  slack: {
    maxRequests: RUNAWAY_LIMIT_PER_WINDOW,
    windowMs: 60 * 1000, // 1 minute
    description: `runaway brake: ${RUNAWAY_LIMIT_PER_WINDOW} app-wide per 1 minute`,
  },
  telegram: {
    maxRequests: RUNAWAY_LIMIT_PER_WINDOW,
    windowMs: 1000, // 1 second
    description: `runaway brake: ${RUNAWAY_LIMIT_PER_WINDOW} app-wide per 1 second`,
  },
  discord: {
    maxRequests: RUNAWAY_LIMIT_PER_WINDOW,
    windowMs: 1000, // 1 second
    description: `runaway brake: ${RUNAWAY_LIMIT_PER_WINDOW} app-wide per 1 second`,
  },
  whatsapp: {
    // Placeholder. Real WhatsApp Cloud API limits are tier/day-based (1k/10k/100k
    // messages per day by phone-number tier), not a fixed per-second rate. Revisit
    // when outbound volume matters (Phase 2 templates/notifications).
    maxRequests: RUNAWAY_LIMIT_PER_WINDOW,
    windowMs: 1000, // 1 second
    description: `runaway brake: ${RUNAWAY_LIMIT_PER_WINDOW} app-wide per 1 second`,
  },
};

/**
 * The real limit: what one connected account may publish.
 *
 * This is the denominator the platforms actually use, so it is the one that
 * decides whether a post may go. Keyed by channel
 * (`ratelimit:channel:<platform>:<channelId>`), which is why it is correct
 * where the app-wide counter above was not.
 *
 * The numbers match what the platforms allow, taken from Buffer's published
 * per-channel caps (Instagram 50/day, TikTok 25/day). They used to read 10 and
 * 5, which throttled customers well before any platform would have — so a
 * customer was stopped twice: once by a cap that was not theirs, and once
 * early by this one.
 *
 * A platform absent from this map is NOT rate-limited here. Only the three
 * that already restricted are listed: adding a fourth would newly cap
 * customers who are not capped today, which is a product decision rather than
 * a bug fix.
 */
export const PER_CHANNEL_LIMITS: Partial<
  Record<SupportedPlatform, { maxRequests: number; windowMs: number }>
> = {
  instagram: { maxRequests: 50, windowMs: 24 * 60 * 60 * 1000 },
  tiktok: { maxRequests: 25, windowMs: 24 * 60 * 60 * 1000 },
  twitter: { maxRequests: 50, windowMs: 60 * 60 * 1000 },
};

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  retryAfterMs?: number;
}

@Injectable()
export class RateLimiterService implements OnApplicationShutdown {
  private readonly logger = new Logger(RateLimiterService.name);
  private redis: Redis;

  constructor(private configService: ConfigService) {
    this.redis = new Redis({
      host: this.configService.get<string>('REDIS_HOST', 'localhost'),
      port: this.configService.get<number>('REDIS_PORT', 6379),
      password: this.configService.get<string>('REDIS_PASSWORD', ''),
      ...(this.configService.get<string>('REDIS_TLS') === 'true' && {
        tls: {},
      }),
    });
  }

  /**
   * Check the app-wide runaway brake for a platform (sliding window).
   *
   * See {@link PLATFORM_RATE_LIMITS}: this is not a customer quota, so a
   * refusal here means something is publishing in a loop, not that a customer
   * has posted too much.
   *
   * Unreachable Redis is treated as allowed. Refusing would turn a Redis blip
   * into failed posts for everyone, and the thing being guarded against — a
   * runaway loop — is far rarer than a brief connection problem.
   * `getRateLimitStatus` already degrades this way; this matches it rather
   * than inventing a second policy.
   */
  async checkRateLimit(platform: SupportedPlatform): Promise<RateLimitResult> {
    const limit = PLATFORM_RATE_LIMITS[platform];
    if (!limit) {
      return { allowed: true, remaining: 999, resetAt: new Date() };
    }

    const key = `ratelimit:global:${platform}`;
    const now = Date.now();
    const windowStart = now - limit.windowMs;

    let currentCount: number;
    try {
      // Remove old entries outside the window
      await this.redis.zremrangebyscore(key, 0, windowStart);

      // Count current requests in window
      currentCount = await this.redis.zcard(key);
    } catch (error) {
      this.logger.warn(
        `Runaway brake unavailable for ${platform} (Redis unreachable), ` +
          `allowing the publish: ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
      return {
        allowed: true,
        remaining: limit.maxRequests,
        resetAt: new Date(now + limit.windowMs),
      };
    }

    if (currentCount >= limit.maxRequests) {
      // When the window reopens: the oldest entry in it, plus the window.
      // A missing or unparseable score falls back to a full window from now —
      // `retryAfterMs` is used as a delay by the publish path, so NaN there
      // would become an invalid job delay rather than a late retry.
      let oldestTimestamp = now;
      try {
        const oldestEntries = await this.redis.zrange(key, 0, 0, 'WITHSCORES');
        const parsed =
          oldestEntries.length >= 2 ? Number(oldestEntries[1]) : Number.NaN;
        if (Number.isFinite(parsed)) oldestTimestamp = parsed;
      } catch {
        // Already past the point of refusing; the fallback above is enough.
      }
      const resetAt = new Date(oldestTimestamp + limit.windowMs);
      const retryAfterMs = Math.max(0, resetAt.getTime() - now);

      this.logger.error(
        `RUNAWAY BRAKE hit for ${platform}: ${currentCount}/${limit.maxRequests} ` +
          `app-wide in ${limit.windowMs}ms. This is not a customer quota — ` +
          `something is publishing in a loop. Retry after ${Math.ceil(retryAfterMs / 1000)}s`,
      );

      return {
        allowed: false,
        remaining: 0,
        resetAt,
        retryAfterMs,
      };
    }

    return {
      allowed: true,
      remaining: limit.maxRequests - currentCount,
      resetAt: new Date(now + limit.windowMs),
    };
  }

  /**
   * Record a request for rate limiting
   */
  async recordRequest(platform: SupportedPlatform): Promise<void> {
    const limit = PLATFORM_RATE_LIMITS[platform];
    if (!limit) return;

    const key = `ratelimit:global:${platform}`;
    const now = Date.now();
    const uniqueId = `${now}-${Math.random().toString(36).substring(2, 11)}`;

    // Add request with timestamp as score
    await this.redis.zadd(key, now, uniqueId);

    // Set expiry on the key (cleanup)
    await this.redis.expire(key, Math.ceil(limit.windowMs / 1000) + 60);
  }

  /**
   * Check what this one connected account may publish — the real limit.
   *
   * See {@link PER_CHANNEL_LIMITS}. A refusal here IS a customer-visible
   * limit, and the publish path holds the post until `retryAfterMs` rather
   * than failing it. Unreachable Redis is allowed through, for the same reason
   * as {@link checkRateLimit}.
   */
  async checkChannelRateLimit(
    platform: SupportedPlatform,
    channelId: string,
  ): Promise<RateLimitResult> {
    const limit = PER_CHANNEL_LIMITS[platform];
    if (!limit) {
      return { allowed: true, remaining: 999, resetAt: new Date() };
    }

    const key = `ratelimit:channel:${platform}:${channelId}`;
    const now = Date.now();
    const windowStart = now - limit.windowMs;

    let currentCount: number;
    try {
      await this.redis.zremrangebyscore(key, 0, windowStart);
      currentCount = await this.redis.zcard(key);
    } catch (error) {
      this.logger.warn(
        `Channel rate limit unavailable for ${platform}:${channelId} ` +
          `(Redis unreachable), allowing the publish: ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
      return {
        allowed: true,
        remaining: limit.maxRequests,
        resetAt: new Date(now + limit.windowMs),
      };
    }

    if (currentCount >= limit.maxRequests) {
      // Same NaN guard as checkRateLimit: retryAfterMs becomes a job delay.
      let oldestTimestamp = now;
      try {
        const oldestEntries = await this.redis.zrange(key, 0, 0, 'WITHSCORES');
        const parsed =
          oldestEntries.length >= 2 ? Number(oldestEntries[1]) : Number.NaN;
        if (Number.isFinite(parsed)) oldestTimestamp = parsed;
      } catch {
        // Already refusing; the fallback above is enough.
      }
      const resetAt = new Date(oldestTimestamp + limit.windowMs);

      return {
        allowed: false,
        remaining: 0,
        resetAt,
        retryAfterMs: Math.max(0, resetAt.getTime() - now),
      };
    }

    return {
      allowed: true,
      remaining: limit.maxRequests - currentCount,
      resetAt: new Date(now + limit.windowMs),
    };
  }

  /**
   * Record a request for a specific channel
   */
  async recordChannelRequest(
    platform: SupportedPlatform,
    channelId: string,
  ): Promise<void> {
    const key = `ratelimit:channel:${platform}:${channelId}`;
    const now = Date.now();
    const uniqueId = `${now}-${Math.random().toString(36).substring(2, 11)}`;

    await this.redis.zadd(key, now, uniqueId);
    await this.redis.expire(key, 25 * 60 * 60); // 25 hours
  }

  /**
   * Get current rate limit status for all platforms.
   *
   * The live counts come from Redis. When Redis is down or slow, ioredis retries
   * every call forever, so a naive loop here hangs the whole admin request until
   * something times it out at the edge (~23s → 500). Instead the entire Redis
   * read races a short timeout: if it can't answer in time, every platform comes
   * back with `current: null` (config known, live count unknown) rather than
   * blocking. The caller and UI already treat null as "usage unknown", which is
   * the honest state when the counter is unreachable.
   */
  async getAllRateLimitStatus(): Promise<
    Record<
      SupportedPlatform,
      {
        current: number | null;
        max: number;
        remaining: number | null;
        windowMs: number;
        description: string;
      }
    >
  > {
    const now = Date.now();

    // Read every platform's counter concurrently, and race the whole batch
    // against a 2s ceiling. One slow key shouldn't hold the rest, and no key
    // should hold the request.
    const readAll = Promise.all(
      Object.entries(PLATFORM_RATE_LIMITS).map(async ([platform, limit]) => {
        const key = `ratelimit:global:${platform}`;
        await this.redis.zremrangebyscore(key, 0, now - limit.windowMs);
        const current = await this.redis.zcard(key);
        return [platform, current] as const;
      }),
    );

    let counts: Map<string, number> | null = null;
    try {
      const settled = await Promise.race([
        readAll,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Rate-limit counter read timed out')),
            2000,
          ),
        ),
      ]);
      counts = new Map(settled);
    } catch (error) {
      this.logger.warn(
        `Rate-limit status unavailable (Redis unreachable): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const status: Record<
      string,
      {
        current: number | null;
        max: number;
        remaining: number | null;
        windowMs: number;
        description: string;
      }
    > = {};

    for (const [platform, limit] of Object.entries(PLATFORM_RATE_LIMITS)) {
      const current = counts?.get(platform) ?? null;
      status[platform] = {
        current,
        max: limit.maxRequests,
        remaining: current === null ? null : Math.max(0, limit.maxRequests - current),
        windowMs: limit.windowMs,
        description: limit.description,
      };
    }

    return status as Record<
      SupportedPlatform,
      {
        current: number | null;
        max: number;
        remaining: number | null;
        windowMs: number;
        description: string;
      }
    >;
  }

  /**
   * Get rate limit status for a specific platform
   */
  async getPlatformRateLimitStatus(platform: SupportedPlatform): Promise<{
    current: number;
    max: number;
    remaining: number;
    resetAt: Date | null;
  }> {
    const limit = PLATFORM_RATE_LIMITS[platform];
    if (!limit) {
      return { current: 0, max: 999, remaining: 999, resetAt: null };
    }

    const key = `ratelimit:global:${platform}`;
    const now = Date.now();
    const windowStart = now - limit.windowMs;

    await this.redis.zremrangebyscore(key, 0, windowStart);
    const currentCount = await this.redis.zcard(key);

    // Get oldest entry for reset time
    let resetAt: Date | null = null;
    if (currentCount > 0) {
      const oldestEntries = await this.redis.zrange(key, 0, 0, 'WITHSCORES');
      if (oldestEntries.length >= 2) {
        resetAt = new Date(parseInt(oldestEntries[1], 10) + limit.windowMs);
      }
    }

    return {
      current: currentCount,
      max: limit.maxRequests,
      remaining: Math.max(0, limit.maxRequests - currentCount),
      resetAt,
    };
  }

  /**
   * Closes on application shutdown, deliberately NOT on module destroy.
   *
   * This client serves the publish path's rate-limit checks, and
   * `@nestjs/bullmq` closes its workers in `onApplicationShutdown` — which
   * Nest runs *after* every `onModuleDestroy`. Cleaning up in the earlier
   * hook would cut this connection while workers were still taking jobs: a
   * publish could reach the platform, fail its own bookkeeping against a
   * closed client, be marked failed, and double-post on retry.
   *
   * A connection that is not ready is dropped rather than quit: QUIT would
   * sit in ioredis's offline queue and hold shutdown up. A failed QUIT drops
   * it too, so this never rejects and never blocks the shutdown sequence.
   */
  async onApplicationShutdown() {
    if (this.redis.status !== 'ready') {
      this.redis.disconnect();
      return;
    }
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
