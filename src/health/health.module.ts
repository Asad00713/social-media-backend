import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health.controller';
import {
  RedisClientProvider,
  RedisClientCloser,
} from '../channels/analytics/redis-client.provider';

/**
 * Liveness and readiness probes.
 *
 * DRIZZLE_POOL comes from the global DrizzleModule. Redis is this module's
 * own client rather than one borrowed from a feature module: a probe must not
 * depend on the health of the thing it is probing for, and a shared client
 * would also make the probe's own reconnect behaviour someone else's concern.
 */
@Module({
  imports: [ConfigModule],
  controllers: [HealthController],
  providers: [RedisClientProvider, RedisClientCloser],
})
export class HealthModule {}
