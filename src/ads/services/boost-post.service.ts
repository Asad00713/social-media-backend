import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { db } from '../../drizzle/db'
import { adAccounts, adCampaigns, adSets, ads } from '../../drizzle/schema'
import { eq, and } from 'drizzle-orm'
import { MetaAdsClient } from './meta-ads.client'
import { ChannelService } from '../../channels/services/channel.service'
import { audienceToMetaTargeting } from '../utils/audience-to-targeting'
import type { CreateBoostDto } from '../dto/create-boost.dto'

@Injectable()
export class BoostPostService {
  constructor(
    private readonly meta: MetaAdsClient,
    private readonly channelService: ChannelService,
  ) {}

  async create(workspaceId: string, userId: string, dto: CreateBoostDto) {
    // Verify ad account belongs to this workspace
    const [acct] = await db
      .select()
      .from(adAccounts)
      .where(and(eq(adAccounts.id, dto.adAccountId), eq(adAccounts.workspaceId, workspaceId)))
    if (!acct) throw new NotFoundException('Ad account not found')
    if (acct.accountStatus !== 1) throw new BadRequestException('Ad account is not active')

    // Resolve channel (includes decrypted accessToken + platformAccountId)
    const channel = await this.channelService.getChannelForPosting(dto.channelId)
    if (!channel) throw new NotFoundException('Channel not found')
    if (channel.workspaceId !== workspaceId) throw new ForbiddenException('Channel does not belong to this workspace')
    if (channel.platform !== 'facebook') throw new BadRequestException('Only FB Page posts supported in Phase 1')
    if (!channel.accessToken) throw new BadRequestException('No access token for channel')

    const userToken = channel.accessToken

    // 1) Campaign — created PAUSED so child entities create cleanly without going live mid-build
    const camp = await this.meta.createCampaign(acct.metaAdAccountId, userToken, {
      name: `Boost — ${dto.platformPostId} — ${new Date().toISOString().slice(0, 10)}`,
      objective: dto.objective,
      status: 'PAUSED',
      special_ad_categories: [],
    })

    // 2) Ad Set
    const targeting = audienceToMetaTargeting(dto.audience)
    const optimizationGoal = dto.objective === 'OUTCOME_ENGAGEMENT' ? 'POST_ENGAGEMENT' : 'REACH'
    const adset = await this.meta.createAdSet(acct.metaAdAccountId, userToken, {
      name: `${camp.id} adset`,
      campaign_id: camp.id,
      daily_budget: dto.dailyBudgetMinor,
      billing_event: 'IMPRESSIONS',
      optimization_goal: optimizationGoal as 'POST_ENGAGEMENT' | 'REACH',
      targeting,
      start_time: dto.startTime,
      end_time: dto.endTime,
      status: 'PAUSED',
      promoted_object: { page_id: channel.platformAccountId },
    })

    // 3) Creative
    const creative = await this.meta.createCreativeBoost(acct.metaAdAccountId, userToken, {
      name: `${camp.id} creative`,
      object_story_id: dto.platformPostId,
    })

    const finalStatus = dto.activateImmediately ? 'ACTIVE' : 'PAUSED'

    // 4) Ad (status follows the caller's choice — PAUSED by default)
    const ad = await this.meta.createAd(acct.metaAdAccountId, userToken, {
      name: `${camp.id} ad`,
      adset_id: adset.id,
      creative: { creative_id: creative.id },
      status: finalStatus,
    })

    // 5) Only flip campaign + ad set to ACTIVE when caller opted in.
    // Otherwise everything stays PAUSED — Meta won't spend until the user
    // activates manually from the Ads overview.
    if (dto.activateImmediately) {
      await this.meta.updateEntityStatus(camp.id, userToken, 'ACTIVE')
      await this.meta.updateEntityStatus(adset.id, userToken, 'ACTIVE')
    }

    // 6) Persist mirrors to DB with the actual status
    const [campRow] = await db
      .insert(adCampaigns)
      .values({
        workspaceId,
        adAccountId: acct.id,
        channelId: dto.channelId,
        metaCampaignId: camp.id,
        name: `Boost — ${dto.platformPostId}`,
        objective: dto.objective,
        kind: 'boost',
        status: finalStatus,
        createdByUserId: userId,
      })
      .returning()

    const [adsetRow] = await db
      .insert(adSets)
      .values({
        workspaceId,
        campaignId: campRow.id,
        metaAdsetId: adset.id,
        name: `${camp.id} adset`,
        status: finalStatus,
        dailyBudgetMinor: dto.dailyBudgetMinor,
        currency: acct.currency,
        startTime: new Date(dto.startTime),
        endTime: dto.endTime ? new Date(dto.endTime) : null,
        optimizationGoal,
        billingEvent: 'IMPRESSIONS',
        targeting: targeting as Record<string, unknown>,
        promotedObject: { page_id: channel.platformAccountId },
      })
      .returning()

    await db.insert(ads).values({
      workspaceId,
      adsetId: adsetRow.id,
      metaAdId: ad.id,
      name: `${camp.id} ad`,
      status: finalStatus,
      metaCreativeId: creative.id,
      creativeSnapshot: { object_story_id: dto.platformPostId },
    })

    return { campaignId: campRow.id, metaCampaignId: camp.id }
  }
}
