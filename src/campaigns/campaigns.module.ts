import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CampaignsController } from './campaigns.controller';
import { EvergreenController } from './evergreen.controller';
import { CampaignsService } from './campaigns.service';
import { EvergreenService } from './evergreen.service';
import { EvergreenScoringService } from './evergreen-scoring.service';
import { CampaignPublishingService } from './campaign-publishing.service';
import { EvergreenFireProcessor } from './processors/evergreen-fire.processor';
import { EvergreenReconcileCron } from './evergreen-reconcile.cron';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { WorkspaceRoleModule } from '../workspace-members/workspace-role.module';
import { PostsModule } from '../posts/posts.module';
import { AiModule } from '../ai/ai.module';
// For PostQueueService — the per-channel scheduling ceiling, which campaign
// slots must respect like any other scheduled post. PostsModule imports
// BillingModule for the same reason but does not re-export the service, and
// BillingModule reaches only Stripe/Drizzle/Notifications — none of which
// import CampaignsModule — so this is a plain import, not a forwardRef.
import { BillingModule } from '../billing/billing.module';
import { QUEUES } from '../queue/queue.module';

@Module({
  imports: [
    DrizzleModule,
    WorkspaceRoleModule,
    BullModule.registerQueue(
      { name: QUEUES.POST_PUBLISHING },
      { name: QUEUES.EVERGREEN_ROTATION },
    ),
    PostsModule,
    AiModule,
    BillingModule,
  ],
  controllers: [CampaignsController, EvergreenController],
  providers: [
    CampaignsService,
    CampaignPublishingService,
    EvergreenService,
    EvergreenScoringService,
    EvergreenFireProcessor,
    EvergreenReconcileCron,
  ],
  exports: [CampaignsService],
})
export class CampaignsModule {}
