import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { AdAccountsService } from './services/ad-accounts.service'
import { AdDraftsService } from './services/ad-drafts.service'
import { BoostPostService } from './services/boost-post.service'
import { LeadCampaignService } from './services/lead-campaign.service'
import { AdInsightsService } from './services/ad-insights.service'
import { AdMutationsService } from './services/ad-mutations.service'
import { MetaAdsClient } from './services/meta-ads.client'
import { ChannelService } from '../channels/services/channel.service'
import { UpsertDraftDto } from './dto/draft.dto'
import { CreateBoostDto } from './dto/create-boost.dto'
import { CreateLeadCampaignDto } from './dto/create-lead-campaign.dto'
import { UpdateCampaignStatusDto, UpdateAdSetBudgetDto } from './dto/ad-mutations.dto'
import { DeliveryEstimateDto } from './dto/delivery-estimate.dto'
import { audienceToMetaTargeting } from './utils/audience-to-targeting'
import { db } from '../drizzle/db'
import { adAccounts, adCampaigns, leads } from '../drizzle/schema'
import { eq, and, desc } from 'drizzle-orm'

interface AuthUser {
  userId: string
  email: string
}

@Controller('ads/workspaces/:workspaceId')
@UseGuards(JwtAuthGuard)
export class AdsController {
  constructor(
    private readonly adAccounts: AdAccountsService,
    private readonly drafts: AdDraftsService,
    private readonly boost: BoostPostService,
    private readonly leadCampaign: LeadCampaignService,
    private readonly insights: AdInsightsService,
    private readonly mutations: AdMutationsService,
    private readonly metaAdsClient: MetaAdsClient,
    private readonly channelService: ChannelService,
  ) {}

  // ==========================================================================
  // Ad accounts
  // ==========================================================================

  /**
   * List synced Meta ad accounts for a workspace.
   * GET /ads/workspaces/:workspaceId/ad-accounts
   */
  @Get('ad-accounts')
  async list(@Param('workspaceId') wid: string) {
    const rows = await this.adAccounts.list(wid)
    return {
      adAccounts: rows.map((r) => ({
        id: r.id,
        metaId: r.metaAdAccountId,
        name: r.name,
        currency: r.currency,
        timezone: r.timezoneName,
        status: r.accountStatus,
        disableReason: r.disableReason,
        canRunAds: r.accountStatus === 1,
        isBillingReady: !!(r.fundingSource as { id?: string } | null)?.id,
        channelId: r.channelId,
      })),
    }
  }

  /**
   * Trigger an ad account sync for a connected Facebook channel.
   * POST /ads/workspaces/:workspaceId/ad-accounts/sync/:channelId
   */
  @Post('ad-accounts/sync/:channelId')
  async sync(
    @Param('workspaceId') wid: string,
    @Param('channelId') channelId: string,
  ) {
    await this.adAccounts.syncForChannel(wid, Number(channelId))
    return { success: true }
  }

  /**
   * List recent FB Page posts available for boosting (boost-wizard picker).
   * GET /ads/workspaces/:workspaceId/channels/:channelId/posts-for-boost
   */
  @Get('channels/:channelId/posts-for-boost')
  async postsForBoost(
    @Param('workspaceId') wid: string,
    @Param('channelId') channelId: string,
  ) {
    const posts = await this.adAccounts.listPagePostsForBoost(wid, Number(channelId))
    return { posts }
  }

  // ==========================================================================
  // Ad drafts — wizard auto-save / resume
  // ==========================================================================

  /**
   * List all drafts for the authenticated user in a workspace.
   * GET /ads/workspaces/:workspaceId/drafts
   */
  @Get('drafts')
  listDrafts(
    @Param('workspaceId') wid: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.drafts.list(wid, user.userId)
  }

  /**
   * Create or update a draft.
   * POST /ads/workspaces/:workspaceId/drafts
   * Body: UpsertDraftDto — include `id` to update, omit to create.
   */
  @Post('drafts')
  upsertDraft(
    @Param('workspaceId') wid: string,
    @CurrentUser() user: AuthUser,
    @Body() body: UpsertDraftDto,
  ) {
    return this.drafts.upsert(wid, user.userId, body)
  }

  /**
   * Get a single draft by id.
   * GET /ads/workspaces/:workspaceId/drafts/:id
   */
  @Get('drafts/:id')
  getDraft(
    @Param('workspaceId') wid: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.drafts.get(wid, user.userId, id)
  }

  /**
   * Delete a draft by id.
   * DELETE /ads/workspaces/:workspaceId/drafts/:id
   */
  @Delete('drafts/:id')
  @HttpCode(HttpStatus.OK)
  deleteDraft(
    @Param('workspaceId') wid: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.drafts.delete(wid, user.userId, id)
  }

  // ==========================================================================
  // Boost Post
  // ==========================================================================

  /**
   * Create a boost campaign for a Facebook Page post.
   * POST /ads/workspaces/:workspaceId/boost
   */
  @Post('boost')
  createBoost(
    @Param('workspaceId') wid: string,
    @CurrentUser() user: AuthUser,
    @Body() body: CreateBoostDto,
  ) {
    return this.boost.create(wid, user.userId, body)
  }

  // ==========================================================================
  // Lead Campaigns
  // ==========================================================================

  /**
   * Create a Lead Ads campaign (form + image upload + campaign + adset + creative + ad).
   * POST /ads/workspaces/:workspaceId/lead-campaigns
   */
  @Post('lead-campaigns')
  createLeadCampaign(
    @Param('workspaceId') wid: string,
    @CurrentUser() user: AuthUser,
    @Body() body: CreateLeadCampaignDto,
  ) {
    return this.leadCampaign.create(wid, user.userId, body)
  }

  // ==========================================================================
  // Ad Insights
  // ==========================================================================

  /**
   * Fetch daily insights rows for all ad sets under a campaign.
   * GET /ads/workspaces/:workspaceId/campaigns/:campaignId/insights?since=YYYY-MM-DD
   *
   * Defaults to the last 7 days when `since` is omitted.
   */
  @Get('campaigns/:campaignId/insights')
  getCampaignInsights(
    @Param('workspaceId') wid: string,
    @Param('campaignId') campaignId: string,
    @Query('since') since?: string,
  ) {
    const sinceDate = since ?? defaultSince()
    return this.insights.getForCampaign(wid, campaignId, sinceDate)
  }

  // ==========================================================================
  // Campaign list / pause / resume
  // ==========================================================================

  /**
   * List all campaigns for a workspace, newest first.
   * GET /ads/workspaces/:workspaceId/campaigns
   */
  @Get('campaigns')
  async listCampaigns(@Param('workspaceId') wid: string) {
    const rows = await db
      .select()
      .from(adCampaigns)
      .where(eq(adCampaigns.workspaceId, wid))
      .orderBy(desc(adCampaigns.createdAt))
    return { campaigns: rows }
  }

  /**
   * Pause, resume, or archive a campaign.
   * PATCH /ads/workspaces/:workspaceId/campaigns/:id/status
   * Body: { status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED' }
   */
  @Patch('campaigns/:id/status')
  updateCampaignStatus(
    @Param('workspaceId') wid: string,
    @Param('id') id: string,
    @Body() body: UpdateCampaignStatusDto,
  ) {
    return this.mutations.setCampaignStatus(wid, id, body.status)
  }

  /**
   * Update the daily budget of an ad set (minor units, e.g. cents).
   * PATCH /ads/workspaces/:workspaceId/adsets/:id/budget
   * Body: { dailyBudgetMinor: number }
   */
  @Patch('adsets/:id/budget')
  updateAdSetBudget(
    @Param('workspaceId') wid: string,
    @Param('id') id: string,
    @Body() body: UpdateAdSetBudgetDto,
  ) {
    return this.mutations.setAdSetBudget(wid, id, body.dailyBudgetMinor)
  }

  // ==========================================================================
  // Leads list
  // ==========================================================================

  /**
   * List captured leads for a workspace, optionally filtered by lead form.
   * GET /ads/workspaces/:workspaceId/leads?formId=<uuid>
   *
   * Returns up to 200 rows ordered by capturedAt desc.
   */
  @Get('leads')
  async listLeads(
    @Param('workspaceId') wid: string,
    @Query('formId') formId?: string,
  ) {
    const condition = formId
      ? and(eq(leads.workspaceId, wid), eq(leads.leadFormId, formId))
      : eq(leads.workspaceId, wid)

    const rows = await db
      .select()
      .from(leads)
      .where(condition)
      .orderBy(desc(leads.capturedAt))
      .limit(200)

    return { leads: rows }
  }

  // ==========================================================================
  // Targeting helpers
  // ==========================================================================

  /**
   * Autocomplete Meta's interest taxonomy.
   * GET /ads/workspaces/:workspaceId/targeting/interests?q=<query>&channelId=<id>
   *
   * Returns empty array when q.length < 2.
   */
  @Get('targeting/interests')
  async searchInterests(
    @Param('workspaceId') wid: string,
    @Query('q') q: string,
    @Query('channelId') channelId: string,
  ) {
    if (!q || q.length < 2) {
      return []
    }
    const channel = await this.channelService.getChannelForPosting(Number(channelId))
    if (channel.workspaceId !== wid) {
      throw new ForbiddenException('Channel does not belong to this workspace')
    }
    const token = channel.accessToken ?? ''
    return this.metaAdsClient.searchInterests(q, token)
  }

  /**
   * Autocomplete Meta's geo-location taxonomy (cities only).
   * GET /ads/workspaces/:workspaceId/targeting/geo-locations?q=<query>&channelId=<id>
   *
   * Returns empty array when q.length < 2.
   */
  @Get('targeting/geo-locations')
  async searchGeoLocations(
    @Param('workspaceId') wid: string,
    @Query('q') q: string,
    @Query('channelId') channelId: string,
  ) {
    if (!q || q.length < 2) {
      return []
    }
    const channel = await this.channelService.getChannelForPosting(Number(channelId))
    if (channel.workspaceId !== wid) {
      throw new ForbiddenException('Channel does not belong to this workspace')
    }
    const token = channel.accessToken ?? ''
    return this.metaAdsClient.searchGeoLocations(q, token)
  }

  /**
   * Autocomplete Meta's locale taxonomy.
   * GET /ads/workspaces/:workspaceId/targeting/languages?q=<query>&channelId=<id>
   *
   * Returns empty array when q.length < 2.
   */
  @Get('targeting/languages')
  async searchLanguages(
    @Param('workspaceId') wid: string,
    @Query('q') q: string,
    @Query('channelId') channelId: string,
  ) {
    if (!q || q.length < 2) {
      return []
    }
    const channel = await this.channelService.getChannelForPosting(Number(channelId))
    if (channel.workspaceId !== wid) {
      throw new ForbiddenException('Channel does not belong to this workspace')
    }
    const token = channel.accessToken ?? ''
    return this.metaAdsClient.searchLanguages(q, token)
  }

  /**
   * Autocomplete Meta's behavior taxonomy.
   * GET /ads/workspaces/:workspaceId/targeting/behaviors?q=<query>&channelId=<id>
   *
   * Returns empty array when q.length < 2.
   */
  @Get('targeting/behaviors')
  async searchBehaviors(
    @Param('workspaceId') wid: string,
    @Query('q') q: string,
    @Query('channelId') channelId: string,
  ) {
    if (!q || q.length < 2) {
      return []
    }
    const channel = await this.channelService.getChannelForPosting(Number(channelId))
    if (channel.workspaceId !== wid) {
      throw new ForbiddenException('Channel does not belong to this workspace')
    }
    const token = channel.accessToken ?? ''
    return this.metaAdsClient.searchBehaviors(q, token)
  }

  /**
   * Autocomplete Meta's detailed-demographics taxonomy.
   * GET /ads/workspaces/:workspaceId/targeting/demographics?q=<query>&channelId=<id>
   *
   * Returns empty array when q.length < 2.
   */
  @Get('targeting/demographics')
  async searchDemographics(
    @Param('workspaceId') wid: string,
    @Query('q') q: string,
    @Query('channelId') channelId: string,
  ) {
    if (!q || q.length < 2) {
      return []
    }
    const channel = await this.channelService.getChannelForPosting(Number(channelId))
    if (channel.workspaceId !== wid) {
      throw new ForbiddenException('Channel does not belong to this workspace')
    }
    const token = channel.accessToken ?? ''
    return this.metaAdsClient.searchDemographics(q, token)
  }

  /**
   * Estimate audience delivery for given targeting parameters.
   * POST /ads/workspaces/:workspaceId/targeting/delivery-estimate
   * Body: DeliveryEstimateDto
   */
  @Post('targeting/delivery-estimate')
  async getDeliveryEstimate(
    @Param('workspaceId') wid: string,
    @Body() body: DeliveryEstimateDto,
  ) {
    const [account] = await db
      .select()
      .from(adAccounts)
      .where(and(eq(adAccounts.id, body.adAccountId), eq(adAccounts.workspaceId, wid)))
      .limit(1)

    if (!account) {
      throw new NotFoundException('Ad account not found in this workspace')
    }

    const channel = await this.channelService.getChannelForPosting(body.channelId)
    const token = channel.accessToken ?? ''
    const targeting = audienceToMetaTargeting(body.audience)
    return this.metaAdsClient.getDeliveryEstimate(
      account.metaAdAccountId,
      token,
      targeting,
      body.optimizationGoal,
    )
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the date 7 days ago as YYYY-MM-DD (UTC). */
function defaultSince(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 7)
  return d.toISOString().slice(0, 10)
}
