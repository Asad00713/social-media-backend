import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import { Job } from 'bullmq'
import { QUEUES } from '../../queue/queue.module'
import { AdInsightsService } from '../services/ad-insights.service'

interface AdInsightsSyncJobData {
  workspaceId: string
}

@Processor(QUEUES.AD_INSIGHTS_SYNC)
export class AdInsightsSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(AdInsightsSyncProcessor.name)

  constructor(private readonly insightsService: AdInsightsService) {
    super()
  }

  async process(job: Job<AdInsightsSyncJobData>): Promise<{ ok: boolean }> {
    const { workspaceId } = job.data

    this.logger.log(`Processing ad-insights-sync job=${job.id} workspace=${workspaceId}`)

    await this.insightsService.syncWorkspace(workspaceId)

    return { ok: true }
  }
}
