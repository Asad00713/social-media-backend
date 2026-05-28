import { Module } from '@nestjs/common'
import { ChannelsModule } from '../channels/channels.module'
import { RealtimeModule } from '../realtime/realtime.module'
import { EmailModule } from '../email/email.module'
import { AdsController } from './ads.controller'
import { LeadAdsController } from './lead-ads.controller'
import { MetaAdsClient } from './services/meta-ads.client'
import { AdAccountsService } from './services/ad-accounts.service'
import { AdDraftsService } from './services/ad-drafts.service'
import { BoostPostService } from './services/boost-post.service'
import { LeadFormService } from './services/lead-form.service'
import { LeadCampaignService } from './services/lead-campaign.service'
import { LeadRouterService } from './services/lead-router.service'
import { LeadDeliveryProcessor } from './processors/lead-delivery.processor'
import { AdInsightsService } from './services/ad-insights.service'
import { AdInsightsSyncProcessor } from './processors/ad-insights-sync.processor'
import { AdInsightsSyncScheduler } from './schedulers/ad-insights-sync.scheduler'
import { AdMutationsService } from './services/ad-mutations.service'

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
 *
 * LeadRouterService + LeadDeliveryProcessor live here (not in ChannelsModule) because
 * they depend on EmailModule, which is not imported by ChannelsModule. Importing
 * EmailModule in AdsModule is the cleanest path and avoids adding a new dependency to
 * the already-heavy ChannelsModule.
 *
 * AdInsightsService depends on MetaAdsClient + ChannelService, both of which are
 * exported by ChannelsModule, so it can live here in AdsModule.
 * AdInsightsSyncProcessor and AdInsightsSyncScheduler also live here as they only
 * depend on the queue and AdInsightsService.
 */
@Module({
  imports: [ChannelsModule, RealtimeModule, EmailModule],
  controllers: [AdsController, LeadAdsController],
  providers: [
    AdDraftsService,
    LeadRouterService,
    LeadDeliveryProcessor,
    AdInsightsService,
    AdInsightsSyncProcessor,
    AdInsightsSyncScheduler,
    AdMutationsService,
  ],
  exports: [MetaAdsClient, AdAccountsService, AdDraftsService, BoostPostService, LeadFormService, LeadCampaignService, LeadRouterService, AdInsightsService, AdMutationsService],
})
export class AdsModule {}
