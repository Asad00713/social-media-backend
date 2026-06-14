import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';

const DAILY_TTL_SECONDS = 24 * 60 * 60;
const PRE_AUDIT_USER_CAP = 5;
const PER_CREATOR_DAILY_CAP = 15;

/**
 * Subset of ioredis methods used by this service. Matches the pattern in
 * QuotaTrackerService where Redis is injected as a typed interface against
 * the 'REDIS_CLIENT' token (see channels/analytics/redis-client.provider.ts).
 */
export interface TikTokQuotaRedis {
  sadd(key: string, member: string): Promise<number>;
  srem(key: string, member: string): Promise<number>;
  scard(key: string): Promise<number>;
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

/**
 * Enforces two TikTok publishing quotas required for audit compliance:
 *
 *  1. Pre-audit cap (TIKTOK_APP_AUDITED !== 'true'): at most 5 distinct
 *     creators may publish in a rolling 24h window. Required by TikTok's
 *     Direct Post API audit gate.
 *  2. Per-creator daily cap: ~15 posts/day/creator regardless of audit state.
 *
 * Both caps are tracked in Redis with day-bucketed keys and a 24h TTL.
 * Exceeding either cap throws HTTP 429.
 */
@Injectable()
export class TikTokQuotaService {
  private readonly logger = new Logger(TikTokQuotaService.name);

  constructor(@Inject('REDIS_CLIENT') private readonly redis: TikTokQuotaRedis) {}

  private get isAudited(): boolean {
    return process.env.TIKTOK_APP_AUDITED === 'true';
  }

  private dayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * Reserves a TikTok publish slot for a creator on today's date.
   * Throws HttpException 429 when either cap is exceeded.
   */
  async reserveSlot(creatorOpenId: string): Promise<void> {
    const day = this.dayKey();

    if (!this.isAudited) {
      const usersKey = `tiktok:preaudit:users:${day}`;
      const added = await this.redis.sadd(usersKey, creatorOpenId);
      await this.redis.expire(usersKey, DAILY_TTL_SECONDS);
      const distinctUsers = await this.redis.scard(usersKey);

      if (added === 1 && distinctUsers > PRE_AUDIT_USER_CAP) {
        await this.redis.srem(usersKey, creatorOpenId);
        this.logger.warn(
          `TikTok pre-audit cap reached: ${distinctUsers} distinct creators on ${day}`,
        );
        throw new HttpException(
          'TikTok pre-audit cap reached: only 5 users may post per day until our app is audited.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const creatorKey = `tiktok:creator:${creatorOpenId}:${day}`;
    const count = await this.redis.incr(creatorKey);
    if (count === 1) await this.redis.expire(creatorKey, DAILY_TTL_SECONDS);

    if (count > PER_CREATOR_DAILY_CAP) {
      await this.redis.decr(creatorKey);
      this.logger.warn(
        `TikTok per-creator daily cap reached for ${creatorOpenId}: ${count - 1}/${PER_CREATOR_DAILY_CAP}`,
      );
      throw new HttpException(
        `Daily TikTok post limit reached for this creator (${PER_CREATOR_DAILY_CAP}/day).`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
