import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import type { Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { closeRedisConnection } from '../redis-connection-closer';
import { CronLockBootstrap } from './cron-lock.bootstrap';
import { CRON_LOCK_REDIS, CronLockService } from './cron-lock.service';

/**
 * Its own Redis client, following `RedisClientProvider` in
 * `channels/analytics`: BullMQ holds its own connection, and claiming a cron
 * tick must not queue behind job processing.
 *
 * `enableOfflineQueue: false` for the same reason as the metrics client: with
 * the queue on and `maxRetriesPerRequest: null`, a command issued while
 * disconnected neither resolves nor rejects (measured: 5,000 issued, 0
 * settled). Here that would hang the tick rather than skip it, and the
 * `ACQUIRE_TIMEOUT_MS` bound exists precisely so it cannot.
 */
const CronLockRedisProvider: Provider = {
  provide: CRON_LOCK_REDIS,
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

/** A `useFactory` return value gets no lifecycle hooks from Nest, so without
 *  this the connection holds the process open on shutdown. */
class CronLockRedisCloser implements OnApplicationShutdown {
  constructor(@Inject(CRON_LOCK_REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await closeRedisConnection(this.redis);
  }
}

/**
 * Makes every `@Cron` job run on one process per tick.
 *
 * Needed because `ScheduleModule.forRoot()` lives in `AppModule`, so every
 * process that boots the app runs all 28 crons. That is harmless with one
 * process and is the blocker for splitting web from worker (Phase 2 #8): the
 * token-refresh scheduler enqueues a refresh per channel with no `jobId`, and
 * two concurrent refreshes can race into a token the platform has already
 * invalidated — a channel that disconnects itself overnight.
 *
 * Must be imported AFTER `ScheduleModule.forRoot()` in `AppModule`, since the
 * wrap reads the jobs that module registers. The bootstrap logs how many it
 * wrapped, so getting that order wrong is visible rather than silent.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    CronLockRedisProvider,
    CronLockRedisCloser,
    CronLockService,
    CronLockBootstrap,
  ],
  exports: [CronLockService],
})
export class SchedulingModule {}
