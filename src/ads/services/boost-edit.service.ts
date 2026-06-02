import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common'
import { eq, and } from 'drizzle-orm'
import { db } from '../../drizzle/db'
import { adCampaigns, adSets } from '../../drizzle/schema'
import { MetaAdsClient } from './meta-ads.client'
import { ChannelService } from '../../channels/services/channel.service'
import { audienceToMetaTargeting } from '../utils/audience-to-targeting'
import type { BoostEditDto } from '../dto/boost-edit.dto'

@Injectable()
export class BoostEditService {
  private readonly logger = new Logger(BoostEditService.name)

  constructor(
    private readonly meta: MetaAdsClient,
    private readonly channelService: ChannelService,
  ) {}

  async apply(workspaceId: string, campaignId: string, dto: BoostEditDto) {
    // Load campaign + its (single) ad set
    const [campaign] = await db
      .select()
      .from(adCampaigns)
      .where(and(eq(adCampaigns.id, campaignId), eq(adCampaigns.workspaceId, workspaceId)))
      .limit(1)
    if (!campaign) throw new NotFoundException('Campaign not found')
    if (campaign.kind !== 'boost') throw new BadRequestException('Only boost campaigns can be edited via this endpoint')

    const [adset] = await db
      .select()
      .from(adSets)
      .where(eq(adSets.campaignId, campaign.id))
      .limit(1)
    if (!adset) throw new NotFoundException('Ad set not found for this campaign')

    const channel = await this.channelService.getChannelForPosting(campaign.channelId)
    if (!channel || channel.workspaceId !== workspaceId) throw new ForbiddenException('Channel mismatch')
    if (!channel.accessToken) throw new BadRequestException('No access token for channel')

    const cachedUserToken = (channel.metadata as Record<string, unknown> | null)?.['fbUserAccessToken']
    const userToken =
      typeof cachedUserToken === 'string' && cachedUserToken.length > 0
        ? cachedUserToken
        : channel.accessToken

    // 1. Budget
    if (dto.dailyBudgetMinor !== undefined) {
      await this.meta.updateAdSetBudget(adset.metaAdsetId, userToken, dto.dailyBudgetMinor)
      await db.update(adSets).set({ dailyBudgetMinor: dto.dailyBudgetMinor, updatedAt: new Date() }).where(eq(adSets.id, adset.id))
    }

    // 2. Schedule
    if (dto.startTime !== undefined || dto.endTime !== undefined) {
      await this.meta.updateAdSetSchedule(adset.metaAdsetId, userToken, {
        start_time: dto.startTime,
        end_time: dto.endTime,
      })
      await db.update(adSets).set({
        ...(dto.startTime !== undefined ? { startTime: new Date(dto.startTime) } : {}),
        ...(dto.endTime !== undefined ? { endTime: dto.endTime === null ? null : new Date(dto.endTime) } : {}),
        updatedAt: new Date(),
      }).where(eq(adSets.id, adset.id))
    }

    // 3. Audience
    if (dto.audience) {
      if (!dto.acknowledgeLearningPhaseReset) {
        throw new BadRequestException(
          'Audience edits restart Meta\'s learning phase and can hurt performance. Pass acknowledgeLearningPhaseReset=true to confirm.',
        )
      }
      const targeting = audienceToMetaTargeting(dto.audience)
      await this.meta.updateAdSetTargeting(adset.metaAdsetId, userToken, targeting)
      await db.update(adSets).set({ targeting: targeting as Record<string, unknown>, updatedAt: new Date() }).where(eq(adSets.id, adset.id))
    }

    // 4. Status — pause/resume/archive both campaign + ad set so Meta-side state stays consistent
    if (dto.status) {
      await this.meta.updateEntityStatus(campaign.metaCampaignId, userToken, dto.status)
      await this.meta.updateEntityStatus(adset.metaAdsetId, userToken, dto.status)
      await db.update(adCampaigns).set({ status: dto.status, updatedAt: new Date() }).where(eq(adCampaigns.id, campaign.id))
      await db.update(adSets).set({ status: dto.status, updatedAt: new Date() }).where(eq(adSets.id, adset.id))
    }

    this.logger.log(`Boost ${campaignId} edited: ${Object.keys(dto).join(', ')}`)
    return { ok: true }
  }
}
