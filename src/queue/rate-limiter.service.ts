import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { SupportedPlatform } from '../drizzle/schema/channels.schema';

/**
 * Platform rate limits based on official API documentation
 * These are conservative estimates to stay well within limits
 */
export const PLATFORM_RATE_LIMITS: Record<
  SupportedPlatform,
  { maxRequests: number; windowMs: number; description: string }
> = {
  twitter: {
    maxRequests: 200, // Twitter allows 300 tweets per 3 hours, we use 200 for safety
    windowMs: 3 * 60 * 60 * 1000, // 3 hours
    description: '200 tweets per 3 hours',
  },
  facebook: {
    maxRequests: 150, // Facebook allows ~200 per hour, we use 150
    windowMs: 60 * 60 * 1000, // 1 hour
    description: '150 posts per hour',
  },
  instagram: {
    maxRequests: 20, // Instagram is very strict: 25 per 24 hours
    windowMs: 24 * 60 * 60 * 1000, // 24 hours
    description: '20 posts per 24 hours',
  },
  linkedin: {
    maxRequests: 80, // LinkedIn allows ~100 per day
    windowMs: 24 * 60 * 60 * 1000, // 24 hours
    description: '80 posts per 24 hours',
  },
  pinterest: {
    maxRequests: 50, // Pinterest is relatively generous
    windowMs: 60 * 60 * 1000, // 1 hour
    description: '50 pins per hour',
  },
  tiktok: {
    maxRequests: 8, // TikTok is very strict: ~10 videos per day
    windowMs: 24 * 60 * 60 * 1000, // 24 hours
    description: '8 videos per 24 hours',
  },
  youtube: {
    maxRequests: 50, // YouTube daily upload limit varies
    windowMs: 24 * 60 * 60 * 1000, // 24 hours
    description: '50 videos per 24 hours',
  },
  threads: {
    maxRequests: 20, // Similar to Instagram
    windowMs: 24 * 60 * 60 * 1000, // 24 hours
    description: '20 posts per 24 hours',
  },
  bluesky: {
    maxRequests: 100, // Bluesky has relatively generous rate limits
    windowMs: 60 * 60 * 1000, // 1 hour
    description: '100 posts per hour',
  },
  mastodon: {
    maxRequests: 300, // Mastodon default is 300 requests per 5 minutes
    windowMs: 5 * 60 * 1000, // 5 minutes
    description: '300 requests per 5 minutes',
  },
  google_drive: {
    maxRequests: 1000, // Google Drive has generous read limits
    windowMs: 60 * 60 * 1000, // 1 hour
    description: '1000 requests per hour',
  },
  google_photos: {
    maxRequests: 1000, // Google Photos has generous read limits
    windowMs: 60 * 60 * 1000, // 1 hour
    description: '1000 requests per hour',
  },
  google_calendar: {
    maxRequests: 1000, // Google Calendar has generous limits
    windowMs: 60 * 60 * 1000, // 1 hour
    description: '1000 requests per hour',
  },
  onedrive: {
    maxRequests: 10000, // Microsoft Graph has generous limits
    windowMs: 10 * 60 * 1000, // 10 minutes
    description: '10000 requests per 10 minutes',
  },
  dropbox: {
    maxRequests: 1000, // Dropbox rate limits vary by endpoint
    windowMs: 60 * 60 * 1000, // 1 hour
    description: '1000 requests per hour',
  },
};

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  retryAfterMs?: number;
}

@Injectable()
export class RateLimiterService {
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
   * Check if we can make a request for a platform (global limit)
   * Uses sliding window algorithm
   */
  async checkRateLimit(platform: SupportedPlatform): Promise<RateLimitResult> {
    const limit = PLATFORM_RATE_LIMITS[platform];
    if (!limit) {
      return { allowed: true, remaining: 999, resetAt: new Date() };
    }

    const key = `ratelimit:global:${platform}`;
    const now = Date.now();
    const windowStart = now - limit.windowMs;

    // Remove old entries outside the window
    await this.redis.zremrangebyscore(key, 0, windowStart);

    // Count current requests in window
    const currentCount = await this.redis.zcard(key);

    if (currentCount >= limit.maxRequests) {
      // Get the oldest entry to calculate when it expires
      const oldestEntries = await this.redis.zrange(key, 0, 0, 'WITHSCORES');
      const oldestTimestamp = oldestEntries.length >= 2 ? parseInt(oldestEntries[1], 10) : now;
      const resetAt = new Date(oldestTimestamp + limit.windowMs);
      const retryAfterMs = resetAt.getTime() - now;

      this.logger.warn(
        `Rate limit reached for ${platform}: ${currentCount}/${limit.maxRequests}. Retry after ${Math.ceil(retryAfterMs / 1000)}s`,
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
   * Check rate limit for a specific channel (per-account limit)
   * Some platforms have per-account limits in addition to global
   */
  async checkChannelRateLimit(
    platform: SupportedPlatform,
    channelId: string,
  ): Promise<RateLimitResult> {
    // Per-channel limits (more restrictive for individual accounts)
    const perChannelLimits: Partial<Record<SupportedPlatform, { maxRequests: number; windowMs: number }>> = {
      instagram: { maxRequests: 10, windowMs: 24 * 60 * 60 * 1000 }, // 10 per day per account
      tiktok: { maxRequests: 5, windowMs: 24 * 60 * 60 * 1000 }, // 5 per day per account
      twitter: { maxRequests: 50, windowMs: 60 * 60 * 1000 }, // 50 per hour per account
    };

    const limit = perChannelLimits[platform];
    if (!limit) {
      return { allowed: true, remaining: 999, resetAt: new Date() };
    }

    const key = `ratelimit:channel:${platform}:${channelId}`;
    const now = Date.now();
    const windowStart = now - limit.windowMs;

    await this.redis.zremrangebyscore(key, 0, windowStart);
    const currentCount = await this.redis.zcard(key);

    if (currentCount >= limit.maxRequests) {
      const oldestEntries = await this.redis.zrange(key, 0, 0, 'WITHSCORES');
      const oldestTimestamp = oldestEntries.length >= 2 ? parseInt(oldestEntries[1], 10) : now;
      const resetAt = new Date(oldestTimestamp + limit.windowMs);

      return {
        allowed: false,
        remaining: 0,
        resetAt,
        retryAfterMs: resetAt.getTime() - now,
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
  async recordChannelRequest(platform: SupportedPlatform, channelId: string): Promise<void> {
    const key = `ratelimit:channel:${platform}:${channelId}`;
    const now = Date.now();
    const uniqueId = `${now}-${Math.random().toString(36).substring(2, 11)}`;

    await this.redis.zadd(key, now, uniqueId);
    await this.redis.expire(key, 25 * 60 * 60); // 25 hours
  }

  /**
   * Get current rate limit status for all platforms
   */
  async getAllRateLimitStatus(): Promise<
    Record<SupportedPlatform, { current: number; max: number; remaining: number; windowMs: number }>
  > {
    const status: any = {};

    for (const [platform, limit] of Object.entries(PLATFORM_RATE_LIMITS)) {
      const key = `ratelimit:global:${platform}`;
      const now = Date.now();
      const windowStart = now - limit.windowMs;

      await this.redis.zremrangebyscore(key, 0, windowStart);
      const currentCount = await this.redis.zcard(key);

      status[platform] = {
        current: currentCount,
        max: limit.maxRequests,
        remaining: Math.max(0, limit.maxRequests - currentCount),
        windowMs: limit.windowMs,
        description: limit.description,
      };
    }

    return status;
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
   * Clean up on module destroy
   */
  async onModuleDestroy() {
    await this.redis.quit();
  }
}
