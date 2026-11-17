import {
  Inject,
  Injectable,
  OnApplicationShutdown,
  Provider,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { closeRedisConnection } from '../../common/redis-connection-closer';

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

/**
 * Closes the client above when the application shuts down.
 *
 * A `useFactory` provider's return value gets no lifecycle hooks from Nest,
 * so without this the connection stays open and holds the process up. This
 * lives next to the provider, and every module that registers one registers
 * the other, so a new consumer cannot pick up the client and silently leak it.
 *
 * Several modules register this provider, and each gets its own client —
 * so each also gets its own closer, which is exactly right.
 */
@Injectable()
export class RedisClientCloser implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await closeRedisConnection(this.redis);
  }
}
