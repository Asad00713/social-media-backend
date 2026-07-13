import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PostsController } from './posts.controller';
import { PostService } from './services/post.service';
import { ChannelsModule } from '../channels/channels.module';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { QueueModule, QUEUES } from '../queue/queue.module';
import { AnalyticsModule } from '../channels/analytics/analytics.module';
import { MediaModule } from '../media/media.module';
import { CalendarSyncModule } from '../calendar-sync/calendar-sync.module';

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
import { BlueskyPublisher } from './publishers/bluesky.publisher';
import { MastodonPublisher } from './publishers/mastodon.publisher';
import { RedditPublisher } from './publishers/reddit.publisher';

// Processors (BullMQ job handlers)
import { PostPublishProcessor } from './processors/post-publish.processor';

@Module({
  imports: [
    ChannelsModule,
    DrizzleModule,
    QueueModule,
    BullModule.registerQueue({ name: QUEUES.CHANNEL_SNAPSHOTS }),
    AnalyticsModule,
    MediaModule,
    // Circular by design: posts push to calendars (CalendarPushSyncService) and
    // calendars write back to posts (CalendarPullSyncService → PostService).
    forwardRef(() => CalendarSyncModule),
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
    BlueskyPublisher,
    MastodonPublisher,
    RedditPublisher,
    PostPublishProcessor,
  ],
  exports: [PostService, PublisherFactory],
})
export class PostsModule {}
