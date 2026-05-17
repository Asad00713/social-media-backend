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
import { ChannelInitialBackfillProcessor } from './processors/channel-initial-backfill.processor';
import { ChannelSnapshotsScheduler } from './schedulers/channel-snapshots.scheduler';
import { ChannelSyncLifecycleService } from './services/channel-sync-lifecycle.service';
import { YouTubeAnalyticsAdapter } from './adapters/youtube/youtube-analytics.adapter';
import { YouTubeDataApiClient } from './adapters/youtube/youtube-data-api.client';
import { YouTubeAnalyticsApiClient } from './adapters/youtube/youtube-analytics-api.client';
import { AdapterRegistryService } from './services/adapter-registry.service';

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
    ChannelInitialBackfillProcessor,
    ChannelSnapshotsScheduler,
    ChannelSyncLifecycleService,
    { provide: YouTubeDataApiClient, useValue: new YouTubeDataApiClient() },
    { provide: YouTubeAnalyticsApiClient, useValue: new YouTubeAnalyticsApiClient() },
    YouTubeAnalyticsAdapter,
    AdapterRegistryService,
  ],
  exports: [QuotaTrackerService, AnalyticsService, ChannelSyncLifecycleService, AdapterRegistryService],
})
export class AnalyticsModule {}
