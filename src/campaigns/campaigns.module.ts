import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CampaignsController } from './campaigns.controller';
import { EvergreenController } from './evergreen.controller';
import { CampaignsService } from './campaigns.service';
import { EvergreenService } from './evergreen.service';
import { CampaignPublishingService } from './campaign-publishing.service';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { PostsModule } from '../posts/posts.module';
import { QUEUES } from '../queue/queue.module';

@Module({
  imports: [
    DrizzleModule,
    BullModule.registerQueue({ name: QUEUES.POST_PUBLISHING }),
    PostsModule,
  ],
  controllers: [CampaignsController, EvergreenController],
  providers: [CampaignsService, CampaignPublishingService, EvergreenService],
  exports: [CampaignsService],
})
export class CampaignsModule {}
