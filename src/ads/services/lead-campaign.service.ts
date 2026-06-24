import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { db } from '../../drizzle/db';
import { adAccounts, adCampaigns, adSets, ads } from '../../drizzle/schema';
import { eq, and } from 'drizzle-orm';
import { MetaAdsClient } from './meta-ads.client';
import { ChannelService } from '../../channels/services/channel.service';
import { LeadFormService } from './lead-form.service';
import { audienceToMetaTargeting } from '../utils/audience-to-targeting';
import type { CreateLeadCampaignDto } from '../dto/create-lead-campaign.dto';

@Injectable()
export class LeadCampaignService {
  constructor(
    private readonly meta: MetaAdsClient,
    private readonly channelService: ChannelService,
    private readonly leadForms: LeadFormService,
  ) {}

  async create(
    workspaceId: string,
    userId: string,
    dto: CreateLeadCampaignDto,
  ) {
    // Verify ad account belongs to this workspace
    const [acct] = await db
      .select()
      .from(adAccounts)
      .where(
        and(
          eq(adAccounts.id, dto.adAccountId),
          eq(adAccounts.workspaceId, workspaceId),
        ),
      );
    if (!acct) throw new NotFoundException('Ad account not found');
    if (acct.accountStatus !== 1)
      throw new BadRequestException('Ad account is not active');

    // Resolve channel — includes decrypted accessToken + platformAccountId
    const channel = await this.channelService.getChannelForPosting(
      dto.channelId,
    );
    if (!channel) throw new NotFoundException('Channel not found');
    if (channel.workspaceId !== workspaceId)
      throw new ForbiddenException('Channel does not belong to this workspace');
    if (channel.platform !== 'facebook')
      throw new BadRequestException('Lead Ads require an FB Page channel');
    if (!channel.accessToken)
      throw new BadRequestException('No access token for channel');

    // The channel.accessToken is the Page token (scoped to page-level
    // operations). Ad-account-level Meta endpoints — /adimages, /campaigns,
    // /adsets, /ads, /adcreatives — all require a USER token with
    // ads_management. We cache that user token in channel.metadata at
    // ads-OAuth time. Fall back to the page token only if no cached user
    // token exists (will surface a clearer error than (#3) capability).
    const cachedUserToken = (
      channel.metadata as Record<string, unknown> | null
    )?.['fbUserAccessToken'];
    const userToken =
      typeof cachedUserToken === 'string' && cachedUserToken.length > 0
        ? cachedUserToken
        : channel.accessToken;
    if (!userToken) {
      throw new BadRequestException(
        'No ads-capable access token for this channel. Please reconnect the Facebook page with ads permissions.',
      );
    }

    // 1) Create lead form (synchronously — its id is required by the creative)
    const formRow = await this.leadForms.create(
      workspaceId,
      dto.channelId,
      dto.form,
    );

    // 2) Image: skip /adimages upload (requires Marketing API standard access,
    //    blocked in dev-mode apps with the new use-case model) and pass the
    //    public R2 URL directly as link_data.picture instead. Meta accepts both.

    // 3) Campaign — created PAUSED so child entities create cleanly without going live mid-build
    const camp = await this.meta.createCampaign(
      acct.metaAdAccountId,
      userToken,
      {
        name: dto.campaignName,
        objective: 'OUTCOME_LEADS',
        status: 'PAUSED',
        special_ad_categories: dto.specialAdCategories,
      },
    );

    // 4) Ad Set
    const targeting = audienceToMetaTargeting(dto.audience);
    const adset = await this.meta.createAdSet(acct.metaAdAccountId, userToken, {
      name: `${dto.campaignName} adset`,
      campaign_id: camp.id,
      daily_budget: dto.dailyBudgetMinor,
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'LEAD_GENERATION',
      targeting,
      start_time: dto.startTime,
      end_time: dto.endTime,
      status: 'PAUSED',
      promoted_object: { page_id: channel.platformAccountId },
    });

    // 5) Creative
    const creative = await this.meta.createCreativeLead(
      acct.metaAdAccountId,
      userToken,
      {
        name: `${dto.campaignName} creative`,
        object_story_spec: {
          page_id: channel.platformAccountId,
          link_data: {
            message: dto.primaryText,
            link: dto.form.privacyPolicy.url,
            name: dto.headline,
            description: dto.description,
            picture: dto.creativeImageUrl,
            call_to_action: {
              type: dto.ctaType,
              value: { lead_gen_form_id: formRow.metaFormId },
            },
          },
        },
      },
    );

    const finalStatus = dto.activateImmediately ? 'ACTIVE' : 'PAUSED';

    // 6) Ad (status follows the caller's choice — PAUSED by default)
    const ad = await this.meta.createAd(acct.metaAdAccountId, userToken, {
      name: `${dto.campaignName} ad`,
      adset_id: adset.id,
      creative: { creative_id: creative.id },
      status: finalStatus,
    });

    // 7) Only flip to ACTIVE if the caller opted in — otherwise the
    // campaign stays PAUSED until the user activates it manually.
    if (dto.activateImmediately) {
      await this.meta.updateEntityStatus(camp.id, userToken, 'ACTIVE');
      await this.meta.updateEntityStatus(adset.id, userToken, 'ACTIVE');
    }

    // 8) Persist mirror to DB with the real status
    const [campRow] = await db
      .insert(adCampaigns)
      .values({
        workspaceId,
        adAccountId: acct.id,
        channelId: dto.channelId,
        metaCampaignId: camp.id,
        name: dto.campaignName,
        objective: 'OUTCOME_LEADS',
        kind: 'lead_gen',
        status: finalStatus,
        specialAdCategories: dto.specialAdCategories,
        createdByUserId: userId,
      })
      .returning();

    const [adsetRow] = await db
      .insert(adSets)
      .values({
        workspaceId,
        campaignId: campRow.id,
        metaAdsetId: adset.id,
        name: `${dto.campaignName} adset`,
        status: finalStatus,
        dailyBudgetMinor: dto.dailyBudgetMinor,
        currency: acct.currency,
        startTime: new Date(dto.startTime),
        endTime: dto.endTime ? new Date(dto.endTime) : null,
        optimizationGoal: 'LEAD_GENERATION',
        billingEvent: 'IMPRESSIONS',
        targeting: targeting as Record<string, unknown>,
        promotedObject: { page_id: channel.platformAccountId },
      })
      .returning();

    await db.insert(ads).values({
      workspaceId,
      adsetId: adsetRow.id,
      metaAdId: ad.id,
      name: `${dto.campaignName} ad`,
      status: finalStatus,
      metaCreativeId: creative.id,
      creativeSnapshot: {
        headline: dto.headline,
        primaryText: dto.primaryText,
        imageUrl: dto.creativeImageUrl,
        leadFormId: formRow.id,
      },
    });

    return {
      campaignId: campRow.id,
      metaCampaignId: camp.id,
      leadFormId: formRow.id,
      metaFormId: formRow.metaFormId,
    };
  }
}
