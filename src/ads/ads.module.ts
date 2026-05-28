import { Module } from '@nestjs/common'
import { ChannelsModule } from '../channels/channels.module'
import { RealtimeModule } from '../realtime/realtime.module'
import { AdsController } from './ads.controller'
import { MetaAdsClient } from './services/meta-ads.client'
import { AdAccountsService } from './services/ad-accounts.service'

/**
 * AdsModule — Meta Ads Phase 1
 *
 * MetaAdsClient and AdAccountsService are declared in ChannelsModule to avoid
 * a circular dependency (AdsModule → ChannelsModule → AdsModule).
 * ChannelsModule exports them, so importing ChannelsModule here makes them
 * available for AdsController's dependency injection.
 */
@Module({
  imports: [ChannelsModule, RealtimeModule],
  controllers: [AdsController],
  providers: [],
  exports: [MetaAdsClient, AdAccountsService],
})
export class AdsModule {}
