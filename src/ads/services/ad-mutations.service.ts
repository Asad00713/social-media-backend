import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { adCampaigns, adSets } from '../../drizzle/schema';
import { MetaAdsClient } from './meta-ads.client';
import { ChannelService } from '../../channels/services/channel.service';
import { AnalyticsEventEmitter } from '../../realtime/analytics-event-emitter.service';

@Injectable()
export class AdMutationsService {
  private readonly logger = new Logger(AdMutationsService.name);

  constructor(
    private readonly meta: MetaAdsClient,
    private readonly channelService: ChannelService,
    private readonly events: AnalyticsEventEmitter,
  ) {}

  /**
   * Pause, resume, or archive a campaign.
   * Updates Meta via Graph API then reflects the new status in our DB.
   * Emits SSE `ad.status.changed` to the workspace after the DB write.
   */
  async setCampaignStatus(
    workspaceId: string,
    campaignId: string,
    status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED',
  ): Promise<{ id: string; status: string }> {
    // Load campaign and verify workspace ownership
    const [campaign] = await db
      .select()
      .from(adCampaigns)
      .where(
        and(
          eq(adCampaigns.id, campaignId),
          eq(adCampaigns.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (!campaign) throw new NotFoundException('Campaign not found');

    // Get decrypted access token via channel
    const channel = await this.channelService.getChannelForPosting(
      campaign.channelId,
    );
    if (!channel) throw new NotFoundException('Channel not found');
    if (channel.workspaceId !== workspaceId)
      throw new ForbiddenException('Channel does not belong to this workspace');
    if (!channel.accessToken)
      throw new NotFoundException('No access token for channel');

    // 1. Push status change to Meta
    await this.meta.updateEntityStatus(
      campaign.metaCampaignId,
      channel.accessToken,
      status,
    );
    this.logger.log(`Campaign ${campaign.metaCampaignId} status → ${status}`);

    // 2. Persist in DB
    await db
      .update(adCampaigns)
      .set({ status, updatedAt: new Date() })
      .where(eq(adCampaigns.id, campaignId));

    // 3. Emit SSE so the frontend updates in real-time
    this.events.emit(workspaceId, 'ad.status.changed', {
      workspaceId,
      campaignId,
      entity: 'campaign',
      status,
    });

    return { id: campaignId, status };
  }

  /**
   * Update an ad set's daily budget (in minor units, e.g. cents).
   * Updates Meta via Graph API then reflects the new budget in our DB.
   * No SSE event for budget change per Phase 1 spec.
   */
  async setAdSetBudget(
    workspaceId: string,
    adsetId: string,
    dailyBudgetMinor: number,
  ): Promise<{ id: string; dailyBudgetMinor: number }> {
    // Load ad set and verify workspace ownership
    const [adset] = await db
      .select({
        id: adSets.id,
        metaAdsetId: adSets.metaAdsetId,
        channelId: adCampaigns.channelId,
        workspaceId: adSets.workspaceId,
      })
      .from(adSets)
      .innerJoin(adCampaigns, eq(adSets.campaignId, adCampaigns.id))
      .where(and(eq(adSets.id, adsetId), eq(adSets.workspaceId, workspaceId)))
      .limit(1);

    if (!adset) throw new NotFoundException('Ad set not found');

    // Get decrypted access token via channel
    const channel = await this.channelService.getChannelForPosting(
      adset.channelId,
    );
    if (!channel) throw new NotFoundException('Channel not found');
    if (channel.workspaceId !== workspaceId)
      throw new ForbiddenException('Channel does not belong to this workspace');
    if (!channel.accessToken)
      throw new NotFoundException('No access token for channel');

    // 1. Push budget change to Meta
    await this.meta.updateAdSetBudget(
      adset.metaAdsetId,
      channel.accessToken,
      dailyBudgetMinor,
    );
    this.logger.log(
      `Ad set ${adset.metaAdsetId} dailyBudgetMinor → ${dailyBudgetMinor}`,
    );

    // 2. Persist in DB
    await db
      .update(adSets)
      .set({ dailyBudgetMinor, updatedAt: new Date() })
      .where(eq(adSets.id, adsetId));

    return { id: adsetId, dailyBudgetMinor };
  }
}
