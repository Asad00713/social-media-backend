import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { QuotaTrackerService } from './services/quota-tracker.service';
import { RedisClientProvider } from './redis-client.provider';
import { ChannelLookupRepoProvider } from './guards/channel-ownership.guard';

@Module({
  imports: [ConfigModule],
  providers: [
    QuotaTrackerService,
    RedisClientProvider,
    ChannelLookupRepoProvider,
  ],
  exports: [QuotaTrackerService],
})
export class AnalyticsModule {}
