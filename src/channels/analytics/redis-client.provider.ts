import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

/**
 * Standalone Redis client used by the QuotaTrackerService.
 * BullMQ uses its own internal Redis connection — this is separate so quota
 * reads/writes don't queue behind job processing.
 */
export const RedisClientProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService) =>
    new Redis({
      host: config.get<string>('REDIS_HOST', 'localhost'),
      port: config.get<number>('REDIS_PORT', 6379),
      password: config.get<string>('REDIS_PASSWORD', ''),
      ...(config.get<string>('REDIS_TLS') === 'true' && { tls: {} }),
      maxRetriesPerRequest: null,
    }),
};
