import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../channels/analytics/analytics.module';
import { PostPerformanceModule } from '../post-performance/post-performance.module';
import { QUEUES } from '../queue/queue.module';
import { WorkspaceRoleModule } from '../workspace-members/workspace-role.module';
import { AudienceController } from './audience/audience.controller';
import { AudienceService } from './audience/audience.service';
import { InsightsController } from './insights.controller';
import { InsightsChannelsRepository } from './insights-channels.repository';
import { InsightsService } from './insights.service';
import { InsightsTopicsRepository } from './insights-topics.repository';
import { ReportPayloadService } from './reports/report-payload.service';
import { ReportsController } from './reports/reports.controller';
import { ReportsRepository } from './reports/reports.repository';
import { ReportsService } from './reports/reports.service';

// AnalyticsModule supplies the YouTube client and the Redis client the
// Audience routes read through. The queue is registered here too, to enqueue
// a stale channel's refresh.
// WorkspaceRoleModule (not WorkspaceMembersModule) supplies the guard's
// dependencies without pulling in Billing; see home.module.ts.
@Module({
  imports: [
    WorkspaceRoleModule,
    PostPerformanceModule,
    AnalyticsModule,
    BullModule.registerQueue({ name: QUEUES.CHANNEL_SNAPSHOTS }),
  ],
  controllers: [InsightsController, AudienceController, ReportsController],
  providers: [
    InsightsService,
    AudienceService,
    InsightsTopicsRepository,
    InsightsChannelsRepository,
    ReportsRepository,
    ReportPayloadService,
    ReportsService,
  ],
})
export class InsightsModule {}
