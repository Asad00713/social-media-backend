import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AnalyticsModule } from '../channels/analytics/analytics.module';
import { EmailModule } from '../email/email.module';
import { PostPerformanceModule } from '../post-performance/post-performance.module';
import { QUEUES } from '../queue/queue.module';
import { WorkspaceRoleModule } from '../workspace-members/workspace-role.module';
import { AudienceController } from './audience/audience.controller';
import { AudienceService } from './audience/audience.service';
import { InsightsController } from './insights.controller';
import { InsightsChannelsRepository } from './insights-channels.repository';
import { InsightsService } from './insights.service';
import { InsightsTopicsRepository } from './insights-topics.repository';
import { GotenbergClient } from './reports/gotenberg.client';
import { ReportPayloadService } from './reports/report-payload.service';
import { ReportSendService } from './reports/report-send.service';
import { ReportTokensService } from './reports/report-tokens.service';
import { ReportsController } from './reports/reports.controller';
import { ReportsPublicController } from './reports/reports-public.controller';
import { ReportsProcessor } from './reports/reports.processor';
import { ReportsRepository } from './reports/reports.repository';
import { ReportsScheduler } from './reports/reports.scheduler';
import { ReportsService } from './reports/reports.service';

// AnalyticsModule supplies the YouTube client and the Redis client the
// Audience routes read through. The queues are registered here too: the
// snapshot queue to enqueue a stale channel's refresh, the reports queue for
// Send now, the due-report sweep and the worker that emails them.
// WorkspaceRoleModule (not WorkspaceMembersModule) supplies the guard's
// dependencies without pulling in Billing; see home.module.ts.
@Module({
  imports: [
    WorkspaceRoleModule,
    // The report tokens: signed with JWT_ACCESS_SECRET, as the TikTok proxy's.
    JwtModule.register({}),
    PostPerformanceModule,
    AnalyticsModule,
    EmailModule,
    BullModule.registerQueue(
      { name: QUEUES.CHANNEL_SNAPSHOTS },
      { name: QUEUES.REPORTS },
    ),
  ],
  controllers: [
    InsightsController,
    AudienceController,
    ReportsController,
    ReportsPublicController,
  ],
  providers: [
    InsightsService,
    AudienceService,
    InsightsTopicsRepository,
    InsightsChannelsRepository,
    ReportsRepository,
    ReportPayloadService,
    ReportTokensService,
    {
      provide: GotenbergClient,
      useFactory: (config: ConfigService) =>
        new GotenbergClient(config.get<string>('GOTENBERG_URL')),
      inject: [ConfigService],
    },
    ReportsService,
    ReportSendService,
    ReportsProcessor,
    ReportsScheduler,
  ],
  // The channel page composes one channel's overview, posts and signals.
  exports: [InsightsService],
})
export class InsightsModule {}
