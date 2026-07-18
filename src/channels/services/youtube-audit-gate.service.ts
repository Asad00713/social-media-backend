import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';

const DAILY_TTL_SECONDS = 24 * 60 * 60;
/** Half of videos.insert's ~100/day bucket, leaving headroom for retries. */
const PRE_AUDIT_DAILY_UPLOADS = 50;
const PER_CHANNEL_DAILY_UPLOADS = 10;

/** Subset of ioredis used here — same pattern as TikTokQuotaService. */
export interface YoutubeAuditGateRedis {
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

/**
 * Caps YouTube uploads while the project is on default API quota.
 *
 * Mirrors TikTokQuotaService, which does exactly this for TikTok's Direct Post
 * audit gate. videos.insert draws on its own ~100 calls/day bucket, so an
 * unbounded upload path exhausts a day's uploads for every workspace at once.
 *
 * Two caps:
 *   1. Pre-audit (YOUTUBE_APP_AUDITED !== 'true'): 50 uploads/day app-wide.
 *   2. Per-channel: 10 uploads/day, always — one workspace must not be able
 *      to consume the whole app-wide allowance.
 *
 * The flag defaults to false, so a missing env var fails safe.
 */
@Injectable()
export class YoutubeAuditGateService {
  private readonly logger = new Logger(YoutubeAuditGateService.name);

  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: YoutubeAuditGateRedis,
  ) {}

  private get isAudited(): boolean {
    return process.env.YOUTUBE_APP_AUDITED === 'true';
  }

  private dayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * Reserves an upload slot for a channel today.
   * Throws HttpException 429 when either cap is exceeded.
   */
  async reserveUpload(channelId: number): Promise<void> {
    const day = this.dayKey();

    const channelKey = `youtube:uploads:channel:${channelId}:${day}`;
    const channelCount = await this.redis.incr(channelKey);
    if (channelCount === 1)
      await this.redis.expire(channelKey, DAILY_TTL_SECONDS);

    if (channelCount > PER_CHANNEL_DAILY_UPLOADS) {
      await this.redis.decr(channelKey);
      this.logger.warn(
        `YouTube per-channel upload cap reached for channel ${channelId}: ${channelCount - 1}/${PER_CHANNEL_DAILY_UPLOADS}`,
      );
      throw new HttpException(
        `Daily YouTube upload limit reached for this channel (${PER_CHANNEL_DAILY_UPLOADS}/day).`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (!this.isAudited) {
      const appKey = `youtube:uploads:app:${day}`;
      const appCount = await this.redis.incr(appKey);
      if (appCount === 1) await this.redis.expire(appKey, DAILY_TTL_SECONDS);

      if (appCount > PRE_AUDIT_DAILY_UPLOADS) {
        await this.redis.decr(appKey);
        // Release the channel slot too — this attempt is not proceeding.
        await this.redis.decr(channelKey);
        this.logger.warn(
          `YouTube pre-audit upload cap reached: ${appCount - 1}/${PRE_AUDIT_DAILY_UPLOADS} on ${day}`,
        );
        throw new HttpException(
          'YouTube pre-audit cap reached: uploads are limited until our app is audited.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
  }
}
