import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WorkspaceSuspendedGuard } from './auth/guards/workspace-suspended.guard';
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
import { LogsModule } from './logs/logs.module';
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
import { CampaignsModule } from './campaigns/campaigns.module';
import { BullBoardModule } from '@bull-board/nestjs';
import { ExpressAdapter } from '@bull-board/express';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { QUEUES } from './queue/queue.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    // Registered with no global guard on purpose. Only routes carrying an
    // explicit @Throttle decorator are limited — turning this on for every
    // endpoint would silently start rejecting normal traffic on a platform
    // that has never had rate limiting and has not been measured for it.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
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
    LogsModule,
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
    CampaignsModule,
    BullBoardModule.forRoot({
      // Moved off '/admin/queues' so it stops swallowing the admin queue API,
      // which lives under that same prefix. Bull Board keeps its full job
      // inspector here, behind the basic-auth gate in main.ts; the admin
      // dashboard's own Jobs page reads the JWT-guarded /admin/queues routes.
      route: '/admin/bull-board',
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
  providers: [
    AppService,
    // Global billing-suspension enforcement. A no-op for non-workspace routes
    // and for routes marked @SkipSuspendCheck() (billing); only blocks requests
    // to a workspace whose subscription is hard-suspended.
    { provide: APP_GUARD, useClass: WorkspaceSuspendedGuard },
  ],
})
export class AppModule {}
