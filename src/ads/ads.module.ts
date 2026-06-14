import { Module } from '@nestjs/common'
import { ChannelsModule } from '../channels/channels.module'
import { RealtimeModule } from '../realtime/realtime.module'
import { EmailModule } from '../email/email.module'
import { QueueModule } from '../queue/queue.module'
import { AdsController } from './ads.controller'
import { LeadAdsController } from './lead-ads.controller'
import { AdDraftsService } from './services/ad-drafts.service'
import { LeadRouterService } from './services/lead-router.service'
import { LeadDeliveryProcessor } from './processors/lead-delivery.processor'
import { AdInsightsService } from './services/ad-insights.service'
import { AdInsightsSyncProcessor } from './processors/ad-insights-sync.processor'
import { AdInsightsSyncScheduler } from './schedulers/ad-insights-sync.scheduler'
import { AdMutationsService } from './services/ad-mutations.service'
import { BoostEditService } from './services/boost-edit.service'

/**
 * AdsModule — Meta Ads Phase 1
 *
 * Architecture note: MetaAdsClient, AdAccountsService, BoostPostService,
 * LeadFormService, and LeadCampaignService live in ChannelsModule to avoid a
 * circular dependency (those services need ChannelService for token retrieval).
 * They are exported by ChannelsModule, so importing ChannelsModule here makes
 * them available to AdsController/LeadAdsController via DI. Any module that
 * needs those services should import ChannelsModule directly.
 *
 * Providers that live here (and are therefore exportable from here):
 *   - AdDraftsService — only touches adDrafts table, no channel dependency
 *   - LeadRouterService + LeadDeliveryProcessor — need EmailModule, kept out
 *     of ChannelsModule to keep that module lean
 *   - AdInsightsService + sync processor + scheduler — depend on
 *     MetaAdsClient/ChannelService via ChannelsModule export
 *   - AdMutationsService — same pattern
 */
@Module({
  imports: [ChannelsModule, RealtimeModule, EmailModule, QueueModule],
  controllers: [AdsController, LeadAdsController],
  providers: [
    AdDraftsService,
    LeadRouterService,
    LeadDeliveryProcessor,
    AdInsightsService,
    AdInsightsSyncProcessor,
    AdInsightsSyncScheduler,
    AdMutationsService,
    BoostEditService,
  ],
  exports: [
    AdDraftsService,
    LeadRouterService,
    AdInsightsService,
    AdMutationsService,
  ],
})
export class AdsModule {}
