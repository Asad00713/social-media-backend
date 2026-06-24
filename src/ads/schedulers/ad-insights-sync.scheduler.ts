import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { adCampaigns } from '../../drizzle/schema';
import { QUEUES } from '../../queue/queue.module';

/**
 * Fires daily at 03:00 UTC. For every workspace that has at least one ACTIVE
 * campaign, enqueues an AD_INSIGHTS_SYNC job so yesterday's metrics are pulled
 * from the Meta Graph API and stored in ad_insights_daily.
 *
 * Staggered 200ms apart to avoid thundering-herd pressure on Meta's rate limits.
 */
@Injectable()
export class AdInsightsSyncScheduler {
  private readonly logger = new Logger(AdInsightsSyncScheduler.name);

  constructor(
    @InjectQueue(QUEUES.AD_INSIGHTS_SYNC) private readonly queue: Queue,
  ) {}

  @Cron('0 3 * * *', { timeZone: 'UTC', name: 'enqueueAdInsightsSync' })
  async enqueueAdInsightsSync(): Promise<void> {
    const rows = await db
      .selectDistinct({ workspaceId: adCampaigns.workspaceId })
      .from(adCampaigns)
      .where(eq(adCampaigns.status, 'ACTIVE'));

    if (rows.length === 0) {
      this.logger.verbose(
        'ad-insights-sync: no workspaces with active campaigns',
      );
      return;
    }

    this.logger.log(
      `ad-insights-sync: enqueuing ${rows.length} workspace sync jobs`,
    );

    for (let i = 0; i < rows.length; i++) {
      await this.queue.add(
        'sync',
        { workspaceId: rows[i].workspaceId },
        { delay: i * 200 },
      );
    }
  }
}
