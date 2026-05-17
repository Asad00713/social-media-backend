import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PostsController } from './posts.controller';
import { PostService } from './services/post.service';
import { ChannelsModule } from '../channels/channels.module';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { QueueModule, QUEUES } from '../queue/queue.module';
import { AnalyticsModule } from '../channels/analytics/analytics.module';

// Publishers
import { PublisherFactory } from './publishers/publisher.factory';
import { TwitterPublisher } from './publishers/twitter.publisher';
import { FacebookPublisher } from './publishers/facebook.publisher';
import { InstagramPublisher } from './publishers/instagram.publisher';
import { ThreadsPublisher } from './publishers/threads.publisher';
import { LinkedInPublisher } from './publishers/linkedin.publisher';
import { PinterestPublisher } from './publishers/pinterest.publisher';
import { TikTokPublisher } from './publishers/tiktok.publisher';
import { YouTubePublisher } from './publishers/youtube.publisher';

// Processors (BullMQ job handlers)
import { PostPublishProcessor } from './processors/post-publish.processor';

@Module({
  imports: [
    ChannelsModule,
    DrizzleModule,
    QueueModule,
    BullModule.registerQueue({ name: QUEUES.CHANNEL_SNAPSHOTS }),
    AnalyticsModule,
  ],
  controllers: [PostsController],
  providers: [
    PostService,
    PublisherFactory,
    TwitterPublisher,
    FacebookPublisher,
    InstagramPublisher,
    ThreadsPublisher,
    LinkedInPublisher,
    PinterestPublisher,
    TikTokPublisher,
    YouTubePublisher,
    PostPublishProcessor,
  ],
  exports: [PostService, PublisherFactory],
})
export class PostsModule {}
