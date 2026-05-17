import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { QuotaTrackerService } from './services/quota-tracker.service';
import { AnalyticsService } from './services/analytics.service';
import { AnalyticsController } from './analytics.controller';
import { RedisClientProvider } from './redis-client.provider';
import { ChannelLookupRepoProvider } from './guards/channel-ownership.guard';

@Module({
  imports: [ConfigModule],
  controllers: [AnalyticsController],
  providers: [
    QuotaTrackerService,
    AnalyticsService,
    RedisClientProvider,
    ChannelLookupRepoProvider,
  ],
  exports: [QuotaTrackerService, AnalyticsService],
})
export class AnalyticsModule {}
