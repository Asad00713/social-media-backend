import { Injectable, Logger } from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import { eq, and } from 'drizzle-orm'
import { db } from '../../drizzle/db'
import { leadForms, leads, leadRoutes } from '../../drizzle/schema'
import { QUEUES } from '../../queue/queue.module'
import { MetaAdsClient } from './meta-ads.client'
import { ChannelService } from '../../channels/services/channel.service'
import { AnalyticsEventEmitter } from '../../realtime/analytics-event-emitter.service'

export interface LeadIntakePayload {
  leadgenId: string
  pageId: string
  formId: string
  adId?: string
  adsetId?: string
  campaignId?: string
  createdTime?: number
}

@Injectable()
export class LeadIntakeService {
  private readonly logger = new Logger(LeadIntakeService.name)

  constructor(
    private readonly meta: MetaAdsClient,
    private readonly channelService: ChannelService,
    private readonly events: AnalyticsEventEmitter,
    @InjectQueue(QUEUES.LEAD_DELIVERY) private readonly deliveryQueue: Queue,
  ) {}

  async ingest(payload: LeadIntakePayload): Promise<void> {
    // 1. Look up leadForm row by metaFormId — drop silently if not one of ours
    const formRows = await db
      .select()
      .from(leadForms)
      .where(eq(leadForms.metaFormId, payload.formId))
      .limit(1)

    if (formRows.length === 0) {
      this.logger.verbose(
        `Lead intake: formId=${payload.formId} not found in DB — organic/external form, dropping`,
      )
      return
    }

    const form = formRows[0]

    // 2. Get page-scoped access token via channel
    let pageToken: string | null = null
    try {
      pageToken = await this.channelService.getAccessToken(form.channelId, form.workspaceId)
    } catch (err) {
      this.logger.error(
        `Lead intake: failed to get access token for channel=${form.channelId}: ${(err as Error).message}`,
      )
      return
    }

    if (!pageToken) {
      this.logger.warn(`Lead intake: no page token for channel=${form.channelId}, dropping`)
      return
    }

    // 3. Fetch full lead data from Meta Graph API
    let leadData: Awaited<ReturnType<MetaAdsClient['getLead']>>
    try {
      leadData = await this.meta.getLead(payload.leadgenId, pageToken)
    } catch (err) {
      this.logger.error(
        `Lead intake: getLead failed for leadgenId=${payload.leadgenId}: ${(err as Error).message}`,
      )
      throw err // rethrow so BullMQ retries
    }

    // 4. Insert into leads table — onConflictDoNothing deduplicates webhook replays
    const capturedAt = payload.createdTime
      ? new Date(payload.createdTime * 1000)
      : new Date(leadData.created_time)

    const inserted = await db
      .insert(leads)
      .values({
        workspaceId: form.workspaceId,
        leadFormId: form.id,
        metaLeadgenId: payload.leadgenId,
        metaAdId: payload.adId ?? leadData.ad_id ?? null,
        fieldData: leadData.field_data,
        isOrganic: leadData.is_organic ?? false,
        capturedAt,
        deliveryStatus: 'pending',
        deliveryAttempts: [],
      })
      .onConflictDoNothing()
      .returning()

    if (inserted.length === 0) {
      this.logger.verbose(
        `Lead intake: leadgenId=${payload.leadgenId} already exists — duplicate webhook, skipping`,
      )
      return
    }

    const lead = inserted[0]
    this.logger.log(
      `Lead intake: inserted lead=${lead.id} form=${form.id} workspace=${form.workspaceId}`,
    )

    // 5. Emit SSE event to the workspace
    this.events.emit(form.workspaceId, 'lead.created', {
      workspaceId: form.workspaceId,
      leadId: lead.id,
      leadFormId: form.id,
      capturedAt: capturedAt.toISOString(),
    })

    // 6. Query enabled lead routes for this form and queue delivery jobs
    const routes = await db
      .select()
      .from(leadRoutes)
      .where(and(eq(leadRoutes.leadFormId, form.id), eq(leadRoutes.enabled, true)))

    for (const route of routes) {
      await this.deliveryQueue.add(
        'lead-delivery',
        {
          leadId: lead.id,
          workspaceId: form.workspaceId,
          routeId: route.id,
          routeType: route.type,
          routeConfig: route.config,
        },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        },
      )
    }

    this.logger.log(
      `Lead intake: queued ${routes.length} delivery job(s) for lead=${lead.id}`,
    )
  }
}
