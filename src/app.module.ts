import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SiteVerificationController } from './site-verification/site-verification.controller';
import { SocialMediaModule } from './social-media/social-media.module';
import { PostsModule } from './posts/posts.module';
import { AiModule } from './ai/ai.module';
import { ConfigModule } from '@nestjs/config';
import { DrizzleModule } from './drizzle/drizzle.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { WorkspaceModule } from './workspace/workspace.module';
import { WorkspaceMembersModule } from './workspace-members/workspace-members.module';
import { BillingModule } from './billing/billing.module';
import { StripeModule } from './stripe/stripe.module';
import { ChannelsModule } from './channels/channels.module';
import { MessagingOverviewModule } from './channels/messaging-overview/messaging-overview.module';
import { MediaModule } from './media/media.module';
import { DripModule } from './drips/drip.module';
import { FeedbackModule } from './feedback/feedback.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PexelsModule } from './pexels/pexels.module';
import { StockMediaModule } from './stock-media/stock-media.module';
import { CanvaModule } from './canva/canva.module';
import { MediaLibraryModule } from './media-library/media-library.module';
import { AdminModule } from './admin/admin.module';
import { CommunityModule } from './community/community.module';
import { ChatbotModule } from './chatbot/chatbot.module';
import { MaestroModule } from './maestro/maestro.module';
import { ScheduleModule } from '@nestjs/schedule';
import { AnalyticsModule } from './channels/analytics/analytics.module';
import { RealtimeModule } from './realtime/realtime.module';
import { ComposerModule } from './posts/composer/composer.module';
import { InboxModule } from './inbox/inbox.module';
import { AdsModule } from './ads/ads.module';
import { MediaSourcesModule } from './media-sources/media-sources.module';
import { CalendarSyncModule } from './calendar-sync/calendar-sync.module';
import { BullBoardModule } from '@bull-board/nestjs';
import { ExpressAdapter } from '@bull-board/express';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { QUEUES } from './queue/queue.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    SocialMediaModule,
    DrizzleModule,
    StripeModule,
    UsersModule,
    AuthModule,
    WorkspaceModule,
    WorkspaceMembersModule,
    BillingModule,
    ChannelsModule,
    MessagingOverviewModule,
    PostsModule,
    MediaModule,
    MediaLibraryModule,
    AiModule,
    DripModule,
    FeedbackModule,
    NotificationsModule,
    PexelsModule,
    StockMediaModule,
    CanvaModule,
    AdminModule,
    CommunityModule,
    ChatbotModule,
    MaestroModule,
    AnalyticsModule,
    RealtimeModule,
    ComposerModule,
    InboxModule,
    AdsModule,
    MediaSourcesModule,
    CalendarSyncModule,
    BullBoardModule.forRoot({
      route: '/admin/queues',
      adapter: ExpressAdapter,
    }),
    BullBoardModule.forFeature(
      { name: QUEUES.POST_PUBLISHING, adapter: BullMQAdapter },
      { name: QUEUES.TOKEN_REFRESH, adapter: BullMQAdapter },
      { name: QUEUES.DRIP_CAMPAIGNS, adapter: BullMQAdapter },
      { name: QUEUES.CHANNEL_SNAPSHOTS, adapter: BullMQAdapter },
      { name: QUEUES.INBOX_POLLING, adapter: BullMQAdapter },
    ),
  ],
  controllers: [AppController, SiteVerificationController],
  providers: [AppService],
})
export class AppModule {}
