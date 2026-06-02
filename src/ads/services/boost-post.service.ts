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

    // Same as lead-campaign.service: ad-account endpoints need a USER token,
    // not the Page token. Prefer cached user token from connect-time, fall
    // back to page token (will surface clearer errors than (#3) capability).
    const cachedUserToken = (channel.metadata as Record<string, unknown> | null)?.['fbUserAccessToken']
    const userToken =
      typeof cachedUserToken === 'string' && cachedUserToken.length > 0
        ? cachedUserToken
        : channel.accessToken
    if (!userToken) {
      throw new BadRequestException(
        'No ads-capable access token for this channel. Please reconnect the Facebook page with ads permissions.',
      )
    }

    // 1) Campaign — created PAUSED so child entities create cleanly without going live mid-build
    const camp = await this.meta.createCampaign(acct.metaAdAccountId, userToken, {
      name: `Boost — ${dto.platformPostId} — ${new Date().toISOString().slice(0, 10)}`,
      objective: dto.objective,
      status: 'PAUSED',
      special_ad_categories: [],
    })

    // 2) Ad Set
    const targeting = audienceToMetaTargeting(dto.audience)
    // ODAX (v21+) — each objective maps to specific optimization_goal +
    // billing_event + destination_type. Choices below are the conservative
    // defaults Meta uses in Boost Post UI; advanced users can swap in 2A.4.
    const goalMap: Record<typeof dto.objective, {
      optimization_goal: 'POST_ENGAGEMENT' | 'REACH' | 'LINK_CLICKS' | 'THRUPLAY'
      destination_type?: 'ON_POST' | 'ON_AD' | 'WEBSITE'
      billing_event: 'IMPRESSIONS' | 'LINK_CLICKS'
    }> = {
      OUTCOME_ENGAGEMENT: { optimization_goal: 'POST_ENGAGEMENT', destination_type: 'ON_POST', billing_event: 'IMPRESSIONS' },
      OUTCOME_AWARENESS: { optimization_goal: 'REACH', billing_event: 'IMPRESSIONS' },
      OUTCOME_TRAFFIC: { optimization_goal: 'LINK_CLICKS', destination_type: 'WEBSITE', billing_event: 'IMPRESSIONS' },
      OUTCOME_VIDEO_VIEWS: { optimization_goal: 'THRUPLAY', billing_event: 'IMPRESSIONS' },
    }
    const goal = goalMap[dto.objective]

    const adset = await this.meta.createAdSet(acct.metaAdAccountId, userToken, {
      name: `${camp.id} adset`,
      campaign_id: camp.id,
      daily_budget: dto.dailyBudgetMinor,
      billing_event: goal.billing_event,
      optimization_goal: goal.optimization_goal,
      destination_type: goal.destination_type,
      targeting,
      start_time: dto.startTime,
      end_time: dto.endTime,
      status: 'PAUSED',
      promoted_object: { page_id: channel.platformAccountId },
    })

    // 3) Creative — branch on whether the caller supplied ad-copy overrides.
    // When overrides are present we use object_story_spec (link_data) which
    // lets Meta render a fresh creative with the custom text/headline/link.
    // Without overrides we use object_story_id which re-uses the original post
    // as-is (cheapest path, no extra copy needed).
    const hasOverrides = !!(dto.adMessage || dto.adHeadline || dto.adDescription || dto.adLinkUrl)
    const creative = hasOverrides
      ? await this.meta.createCreativeBoostWithOverrides(acct.metaAdAccountId, userToken, {
          name: `${camp.id} creative`,
          object_story_spec: {
            page_id: channel.platformAccountId,
            link_data: {
              message: dto.adMessage ?? '',
              link: dto.adLinkUrl ?? `https://www.facebook.com/${dto.platformPostId.replace('_', '/posts/')}`,
              name: dto.adHeadline,
              description: dto.adDescription,
              call_to_action:
                dto.objective === 'OUTCOME_TRAFFIC'
                  ? { type: 'LEARN_MORE', value: { link: dto.adLinkUrl ?? `https://www.facebook.com/${dto.platformPostId.replace('_', '/posts/')}` } }
                  : undefined,
            },
          },
        })
      : await this.meta.createCreativeBoost(acct.metaAdAccountId, userToken, {
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
        optimizationGoal: goal.optimization_goal,
        billingEvent: goal.billing_event,
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
      creativeSnapshot: {
        object_story_id: dto.platformPostId,
        adMessage: dto.adMessage,
        adHeadline: dto.adHeadline,
        adDescription: dto.adDescription,
        adLinkUrl: dto.adLinkUrl,
      },
    })

    return { campaignId: campRow.id, metaCampaignId: camp.id }
  }
}
