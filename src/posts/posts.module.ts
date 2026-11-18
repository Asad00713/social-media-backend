import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PostsController } from './posts.controller';
import { PostService } from './services/post.service';
import { PostDraftsService } from './services/post-drafts.service';
import { PlannerPostsService } from './services/planner-posts.service';
import { ChannelsModule } from '../channels/channels.module';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { WorkspaceRoleModule } from '../workspace-members/workspace-role.module';
import { QueueModule, QUEUES } from '../queue/queue.module';
import { AnalyticsModule } from '../channels/analytics/analytics.module';
import { MediaModule } from '../media/media.module';
import { CalendarSyncModule } from '../calendar-sync/calendar-sync.module';
// PostFailureBatchService (C1/C1a email windows). EmailModule imports no
// feature module, so this adds no cycle.
import { EmailModule } from '../email/email.module';
// For PostQueueService — the per-channel scheduling ceiling. BillingModule
// reaches only Stripe/Drizzle/Notifications, none of which import PostsModule,
// so this is a plain import rather than a forwardRef.
import { BillingModule } from '../billing/billing.module';
// Leaf provider (depends only on `db`) — importing the class directly does
// NOT pull in CampaignsModule, so this does not create a module cycle even
// though CampaignsModule imports PostsModule.
import { CampaignStatusSyncListener } from '../campaigns/campaign-status-sync.listener';
// PostLabelsService, for the Planner's labelIds. LabelsModule imports only
// Drizzle and WorkspaceRole, so this adds no cycle.
import { LabelsModule } from '../labels/labels.module';

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
import { SlackPublisher } from './publishers/slack.publisher';
import { DiscordPublisher } from './publishers/discord.publisher';

// Processors (BullMQ job handlers)
import { PostPublishProcessor } from './processors/post-publish.processor';
import { RepeatPostsService } from './services/repeat-posts.service';
import { PostReminderService } from './services/post-reminder.service';
import { PostRescheduleService } from './services/post-reschedule.service';
import { PublishFailureNotifier } from './services/publish-failure-notifier.service';
// workspace.approval_policy. Provided here (not in ComposerModule) so
// PostService can use it too; ComposerModule and the campaign modules import
// PostsModule. Needs WorkspaceRoleModule, imported below.
import { ApprovalPolicyService } from './composer/services/approval-policy.service';

@Module({
  imports: [
    ChannelsModule,
    DrizzleModule,
    WorkspaceRoleModule,
    QueueModule,
    BullModule.registerQueue({ name: QUEUES.CHANNEL_SNAPSHOTS }),
    AnalyticsModule,
    MediaModule,
    BillingModule,
    EmailModule,
    LabelsModule,
    // Circular by design: posts push to calendars (CalendarPushSyncService) and
    // calendars write back to posts (CalendarPullSyncService → PostService).
    forwardRef(() => CalendarSyncModule),
  ],
  controllers: [PostsController],
  providers: [
    PostService,
    PlannerPostsService,
    PostDraftsService,
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
    SlackPublisher,
    DiscordPublisher,
    PostPublishProcessor,
    RepeatPostsService,
    PostReminderService,
    PostRescheduleService,
    PublishFailureNotifier,
    CampaignStatusSyncListener,
    ApprovalPolicyService,
  ],
  exports: [
    PostService,
    PlannerPostsService,
    PostDraftsService,
    PublisherFactory,
    PostReminderService,
    ApprovalPolicyService,
    // The workspace time-zone move re-times scheduled posts with it.
    PostRescheduleService,
  ],
})
export class PostsModule {}
