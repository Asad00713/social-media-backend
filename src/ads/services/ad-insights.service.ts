import { Injectable, Logger } from '@nestjs/common'
import { db } from '../../drizzle/db'
import { adCampaigns, adSets, adInsightsDaily } from '../../drizzle/schema'
import { eq, and, desc, gte } from 'drizzle-orm'
import { MetaAdsClient } from './meta-ads.client'
import { ChannelService } from '../../channels/services/channel.service'

@Injectable()
export class AdInsightsService {
  private readonly logger = new Logger(AdInsightsService.name)

  constructor(
    private readonly meta: MetaAdsClient,
    private readonly channelService: ChannelService,
  ) {}

  /**
   * Pull yesterday's insights for every ACTIVE ad set in the workspace and
   * upsert a row into ad_insights_daily (unique on adsetId + date).
   */
  async syncWorkspace(workspaceId: string): Promise<void> {
    const rows = await db
      .select({
        adsetUuid: adSets.id,
        metaAdsetId: adSets.metaAdsetId,
        channelId: adCampaigns.channelId,
      })
      .from(adSets)
      .innerJoin(adCampaigns, eq(adSets.campaignId, adCampaigns.id))
      .where(and(eq(adSets.workspaceId, workspaceId), eq(adSets.status, 'ACTIVE')))

    if (rows.length === 0) {
      this.logger.verbose(`insights sync: no active ad sets for workspace=${workspaceId}`)
      return
    }

    this.logger.log(`insights sync: syncing ${rows.length} ad sets for workspace=${workspaceId}`)

    for (const row of rows) {
      try {
        const channel = await this.channelService.getChannelForPosting(row.channelId)
        if (!channel?.accessToken) {
          this.logger.warn(`insights sync: no token for channelId=${row.channelId}, skipping adset=${row.adsetUuid}`)
          continue
        }

        const yest = yesterday()
        const insights = await this.meta.getInsights(row.metaAdsetId, channel.accessToken, {
          since: yest,
          until: yest,
        })

        for (const i of insights) {
          const spendMinor = Math.round(parseFloat(i.spend ?? '0') * 100)
          const leadsCount = parseLeadCount(i.actions)

          await db
            .insert(adInsightsDaily)
            .values({
              workspaceId,
              adsetId: row.adsetUuid,
              date: i.date_start,
              impressions: parseInt(i.impressions, 10) || 0,
              reach: parseInt(i.reach, 10) || 0,
              clicks: parseInt(i.clicks, 10) || 0,
              spendMinor,
              leadsCount,
              actions: Object.fromEntries(
                (i.actions ?? []).map((a) => [a.action_type, parseInt(a.value, 10) || 0]),
              ),
            })
            .onConflictDoUpdate({
              target: [adInsightsDaily.adsetId, adInsightsDaily.date],
              set: {
                impressions: parseInt(i.impressions, 10) || 0,
                reach: parseInt(i.reach, 10) || 0,
                clicks: parseInt(i.clicks, 10) || 0,
                spendMinor,
                leadsCount,
                fetchedAt: new Date(),
              },
            })
        }
      } catch (err) {
        // Log and continue so one bad ad set doesn't block the whole workspace sync
        this.logger.error(
          `insights sync: failed for adset=${row.adsetUuid}: ${(err as Error).message}`,
        )
      }
    }
  }

  /**
   * Return daily insights rows for all ad sets belonging to a campaign,
   * filtered by workspaceId and a since-date, sorted newest first.
   */
  async getForCampaign(workspaceId: string, campaignId: string, sinceDate: string) {
    return db
      .select()
      .from(adInsightsDaily)
      .innerJoin(adSets, eq(adInsightsDaily.adsetId, adSets.id))
      .where(
        and(
          eq(adSets.campaignId, campaignId),
          eq(adInsightsDaily.workspaceId, workspaceId),
          gte(adInsightsDaily.date, sinceDate),
        ),
      )
      .orderBy(desc(adInsightsDaily.date))
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns yesterday's date as YYYY-MM-DD (UTC). */
function yesterday(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Parses Meta's actions array to extract the lead count.
 * Meta uses action_type 'lead' for native lead ads and 'leadgen.other' for
 * off-Facebook lead events.
 */
function parseLeadCount(
  actions?: Array<{ action_type: string; value: string }>,
): number {
  if (!actions) return 0
  const action = actions.find(
    (a) => a.action_type === 'lead' || a.action_type === 'leadgen.other',
  )
  return action ? parseInt(action.value, 10) || 0 : 0
}
