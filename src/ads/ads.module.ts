import { Module } from '@nestjs/common'
import { ChannelsModule } from '../channels/channels.module'
import { RealtimeModule } from '../realtime/realtime.module'
import { AdsController } from './ads.controller'
import { MetaAdsClient } from './services/meta-ads.client'
import { AdAccountsService } from './services/ad-accounts.service'
import { AdDraftsService } from './services/ad-drafts.service'
import { BoostPostService } from './services/boost-post.service'

/**
 * AdsModule — Meta Ads Phase 1
 *
 * MetaAdsClient, AdAccountsService, and BoostPostService are declared in
 * ChannelsModule to avoid a circular dependency (AdsModule → ChannelsModule → AdsModule).
 * ChannelsModule exports them, so importing ChannelsModule here makes them
 * available for AdsController's dependency injection.
 *
 * AdDraftsService only touches the adDrafts table and has no channel dependency,
 * so it lives directly in this module's providers.
 */
@Module({
  imports: [ChannelsModule, RealtimeModule],
  controllers: [AdsController],
  providers: [AdDraftsService],
  exports: [MetaAdsClient, AdAccountsService, AdDraftsService, BoostPostService],
})
export class AdsModule {}
