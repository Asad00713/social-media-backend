import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RateLimiterService } from './rate-limiter.service';

// Queue names
export const QUEUES = {
  POST_PUBLISHING: 'post-publishing',
  TOKEN_REFRESH: 'token-refresh',
  DRIP_CAMPAIGNS: 'drip-campaigns',
  CHANNEL_SNAPSHOTS: 'channel-snapshots',
  INBOX_POLLING: 'inbox-polling',
  SCHEDULED_INBOX: 'scheduled-inbox',
  LEAD_INTAKE: 'lead-intake',
  LEAD_DELIVERY: 'lead-delivery',
  AD_INSIGHTS_SYNC: 'ad-insights-sync',
  SLACK_INGEST: 'slack-ingest',
  TELEGRAM_INGEST: 'telegram-ingest',
  DISCORD_INGEST: 'discord-ingest',
} as const;

@Module({
  imports: [
    ConfigModule,
    // BullMQ configuration with Redis
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('REDIS_HOST', 'localhost'),
          port: configService.get<number>('REDIS_PORT', 6379),
          password: configService.get<string>('REDIS_PASSWORD', ''),
          // For cloud Redis (like Upstash), you might need TLS
          ...(configService.get<string>('REDIS_TLS') === 'true' && {
            tls: {},
          }),
        },
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 1000, // Start with 1 second, then 2s, 4s...
          },
          removeOnComplete: {
            count: 1000, // Keep last 1000 completed jobs
            age: 24 * 3600, // Keep for 24 hours
          },
          removeOnFail: {
            count: 5000, // Keep last 5000 failed jobs for debugging
            age: 7 * 24 * 3600, // Keep for 7 days
          },
        },
      }),
    }),

    // Register queues
    BullModule.registerQueue(
      { name: QUEUES.POST_PUBLISHING },
      { name: QUEUES.TOKEN_REFRESH },
      { name: QUEUES.DRIP_CAMPAIGNS },
      { name: QUEUES.CHANNEL_SNAPSHOTS },
      { name: QUEUES.INBOX_POLLING },
      { name: QUEUES.SCHEDULED_INBOX },
      { name: QUEUES.LEAD_INTAKE },
      { name: QUEUES.LEAD_DELIVERY },
      { name: QUEUES.AD_INSIGHTS_SYNC },
      { name: QUEUES.SLACK_INGEST },
      { name: QUEUES.TELEGRAM_INGEST },
      { name: QUEUES.DISCORD_INGEST },
    ),
  ],
  providers: [RateLimiterService],
  exports: [BullModule, RateLimiterService],
})
export class QueueModule {}
