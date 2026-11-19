import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import type { Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import Redis from 'ioredis';
import { closeRedisConnection } from '../redis-connection-closer';
import { RequestRateController } from './request-rate.controller';
import { RequestRateInterceptor } from './request-rate.interceptor';
import { REQUEST_RATE_REDIS, RequestRateService } from './request-rate.service';

/**
 * Its own Redis client, following the pattern `RedisClientProvider` set in
 * `channels/analytics`: BullMQ holds its own connection, and a metrics write
 * must never queue behind job processing.
 *
 * ## `enableOfflineQueue: false` — the one deliberate difference
 *
 * The sibling providers leave ioredis's offline queue on, which is right for
 * them: they issue a command now and then, and buffering it across a brief
 * reconnect is a feature. This client is on **every request**, which inverts
 * the trade.
 *
 * Measured against a closed port: with the queue on, 5,000 commands buffered
 * and **not one settled** — ioredis holds them for a connection that is not
 * coming, so with `maxRetriesPerRequest: null` the promise neither resolves
 * nor rejects. Two consequences, both bad:
 *
 *  - the queue grows with traffic for as long as the outage lasts, holding
 *    every buffered command's closure in memory;
 *  - `record()`'s `.catch()` never runs, so the "fails open, logs once" design
 *    silently does neither — a Redis outage would be invisible.
 *
 * With it off, a command issued while disconnected rejects immediately. That
 * rejection is what `record()` is built to swallow, which is how "no metrics"
 * stays strictly better than "no service".
 */
const RequestRateRedisProvider: Provider = {
  provide: REQUEST_RATE_REDIS,
  inject: [ConfigService],
  useFactory: (config: ConfigService) =>
    new Redis({
      host: config.get<string>('REDIS_HOST', 'localhost'),
      port: config.get<number>('REDIS_PORT', 6379),
      password: config.get<string>('REDIS_PASSWORD', ''),
      ...(config.get<string>('REDIS_TLS') === 'true' && { tls: {} }),
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
    }),
};

/**
 * A `useFactory` return value gets no lifecycle hooks from Nest, so without
 * this the connection holds the process open on shutdown — the same reason
 * `RedisClientCloser` exists next to its provider.
 */
class RequestRateRedisCloser implements OnApplicationShutdown {
  constructor(@Inject(REQUEST_RATE_REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await closeRedisConnection(this.redis);
  }
}

/**
 * Request-rate measurement, ahead of any global rate limit.
 *
 * The interceptor is registered as an `APP_INTERCEPTOR` here rather than in
 * `AppModule` for the same reason `AllowlistGuard` is declared in `AuthModule`:
 * an app-wide provider is global wherever it is declared, but its dependencies
 * resolve against the DECLARING module's injector. The Redis client lives here,
 * so the registration does too.
 *
 * An interceptor, not a guard, and the distinction is the point: a guard can
 * refuse a request and this phase must not. See `request-rate.interceptor.ts`.
 */
@Module({
  imports: [ConfigModule],
  controllers: [RequestRateController],
  providers: [
    RequestRateRedisProvider,
    RequestRateRedisCloser,
    RequestRateService,
    { provide: APP_INTERCEPTOR, useClass: RequestRateInterceptor },
  ],
  exports: [RequestRateService],
})
export class MetricsModule {}
