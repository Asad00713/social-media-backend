import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CampaignsController } from './campaigns.controller';
import { EvergreenController } from './evergreen.controller';
import { CampaignsService } from './campaigns.service';
import { EvergreenService } from './evergreen.service';
import { CampaignPublishingService } from './campaign-publishing.service';
import { EvergreenFireProcessor } from './processors/evergreen-fire.processor';
import { EvergreenReconcileCron } from './evergreen-reconcile.cron';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { PostsModule } from '../posts/posts.module';
import { AiModule } from '../ai/ai.module';
import { QUEUES } from '../queue/queue.module';

@Module({
  imports: [
    DrizzleModule,
    BullModule.registerQueue(
      { name: QUEUES.POST_PUBLISHING },
      { name: QUEUES.EVERGREEN_ROTATION },
    ),
    PostsModule,
    AiModule,
  ],
  controllers: [CampaignsController, EvergreenController],
  providers: [
    CampaignsService,
    CampaignPublishingService,
    EvergreenService,
    EvergreenFireProcessor,
    EvergreenReconcileCron,
  ],
  exports: [CampaignsService],
})
export class CampaignsModule {}
