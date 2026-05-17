import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { QuotaTrackerService } from './services/quota-tracker.service';
import { AnalyticsService } from './services/analytics.service';
import { AnalyticsController } from './analytics.controller';
import { ChannelRefreshController } from './channel-refresh.controller';
import { RedisClientProvider } from './redis-client.provider';
import { ChannelLookupRepoProvider } from './guards/channel-ownership.guard';
import { QUEUES } from '../../queue/queue.module';
import { ChannelProfileSnapshotProcessor } from './processors/channel-profile-snapshot.processor';
import { PostMetricSnapshotProcessor } from './processors/post-metric-snapshot.processor';
import { ChannelDailyRollupProcessor } from './processors/channel-daily-rollup.processor';

@Module({
  imports: [ConfigModule, BullModule.registerQueue({ name: QUEUES.CHANNEL_SNAPSHOTS })],
  controllers: [AnalyticsController, ChannelRefreshController],
  providers: [
    QuotaTrackerService,
    AnalyticsService,
    RedisClientProvider,
    ChannelLookupRepoProvider,
    ChannelProfileSnapshotProcessor,
    PostMetricSnapshotProcessor,
    ChannelDailyRollupProcessor,
  ],
  exports: [QuotaTrackerService, AnalyticsService],
})
export class AnalyticsModule {}
