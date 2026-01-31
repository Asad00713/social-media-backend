import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
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
import { MediaModule } from './media/media.module';
import { DripModule } from './drips/drip.module';
import { FeedbackModule } from './feedback/feedback.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PexelsModule } from './pexels/pexels.module';
import { CanvaModule } from './canva/canva.module';
import { MediaLibraryModule } from './media-library/media-library.module';
import { AdminModule } from './admin/admin.module';
import { CommunityModule } from './community/community.module';
import { ScheduleModule } from '@nestjs/schedule';

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
    PostsModule,
    MediaModule,
    MediaLibraryModule,
    AiModule,
    DripModule,
    FeedbackModule,
    NotificationsModule,
    PexelsModule,
    CanvaModule,
    AdminModule,
    CommunityModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
