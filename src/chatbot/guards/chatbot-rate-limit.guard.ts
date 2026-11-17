import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS = 20; // 20 requests per minute per user

@Injectable()
export class ChatbotRateLimitGuard implements CanActivate, OnApplicationShutdown {
  private readonly logger = new Logger(ChatbotRateLimitGuard.name);
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
   * Closes on application shutdown, not on module destroy: Nest runs every
   * `onModuleDestroy` before `@nestjs/bullmq` closes its workers in
   * `onApplicationShutdown`, so the earlier hook would cut Redis out from
   * under work that is still running. See RateLimiterService for the full
   * reasoning.
   *
   * A connection that is not ready is dropped: QUIT would sit in ioredis's
   * offline queue and hold the shutdown up. A failed QUIT drops it too.
   */
  async onApplicationShutdown() {
    if (this.redis.status !== 'ready') {
      this.redis.disconnect();
      return;
    }
    await this.redis.quit().catch(() => this.redis.disconnect());
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const userId = request.user?.userId;

    if (!userId) return true; // Let auth guard handle missing user

    const key = `chatbot:ratelimit:${userId}`;
    const now = Date.now();
    const windowStart = now - WINDOW_MS;

    try {
      // Sliding window using sorted set
      const pipeline = this.redis.pipeline();
      pipeline.zremrangebyscore(key, 0, windowStart); // Remove expired entries
      pipeline.zcard(key); // Count entries in window
      pipeline.zadd(key, now.toString(), `${now}-${Math.random()}`); // Add current request
      pipeline.expire(key, Math.ceil(WINDOW_MS / 1000) + 1); // TTL cleanup

      const results = await pipeline.exec();
      const count = results?.[1]?.[1] as number;

      if (count >= MAX_REQUESTS) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message:
              'Too many requests. Please wait a moment before sending another message.',
            retryAfter: Math.ceil(WINDOW_MS / 1000),
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      return true;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      // If Redis is down, allow the request (fail open)
      this.logger.warn(`Rate limit check failed: ${error}`);
      return true;
    }
  }
}
